import * as fs from 'fs';
import { ExtensionQueryFlags, PublishedExtension, ExtensionQueryFilterType, PagingDirection, SortByType, SortOrderType, PublishedExtensionFlags } from 'azure-devops-node-api/interfaces/GalleryInterfaces';
import { pack, readManifest, IPackage } from './package';
import * as tmp from 'tmp';
import { getPublisher } from './store';
import { getGalleryAPI, read, getPublishedUrl, log } from './util';
import { validatePublisher } from './validation';
import { Manifest } from './manifest';
import * as denodeify from 'denodeify';
import * as yauzl from 'yauzl';
import * as semver from 'semver';
import * as cp from 'child_process';

const exec = denodeify<string, { cwd?: string; env?: any; }, { stdout: string; stderr: string; }>(cp.exec as any, (err, stdout, stderr) => [err, { stdout, stderr }]);
const tmpName = denodeify<string>(tmp.tmpName);

function readManifestFromPackage(packagePath: string): Promise<Manifest> {
	return new Promise<Manifest>((c, e) => {
		yauzl.open(packagePath, (err, zipfile) => {
			if (err) {
				return e(err);
			}

			const onEnd = () => e(new Error('Manifest not found'));
			zipfile.once('end', onEnd);

			zipfile.on('entry', entry => {
				if (!/^extension\/package\.json$/i.test(entry.fileName)) {
					return;
				}

				zipfile.removeListener('end', onEnd);

				zipfile.openReadStream(entry, (err, stream) => {
					if (err) {
						return e(err);
					}

					const buffers = [];
					stream.on('data', buffer => buffers.push(buffer));
					stream.once('error', e);
					stream.once('end', () => {
						try {
							c(JSON.parse(Buffer.concat(buffers).toString('utf8')));
						} catch (err) {
							e(err);
						}
					});
				});
			});
		});
	});
}

async function _publish(packagePath: string, pat: string, manifest: Manifest): Promise<void> {
	const api = await getGalleryAPI(pat);

	const packageStream = fs.createReadStream(packagePath);

	const name = `${manifest.publisher}.${manifest.name}`;
	const fullName = `${name}@${manifest.version}`;
	console.log(`Publishing ${fullName}...`);

	return api.getExtension(null, manifest.publisher, manifest.name, null, ExtensionQueryFlags.IncludeVersions)
		.catch<PublishedExtension>(err => err.statusCode === 404 ? null : Promise.reject(err))
		.then(extension => {
			if (extension && extension.versions.some(v => v.version === manifest.version)) {
				return Promise.reject(`${fullName} already exists. Version number cannot be the same.`);
			}

			var promise = extension
				? api.updateExtension(undefined, packageStream, manifest.publisher, manifest.name)
				: api.createExtension(undefined, packageStream);

			return promise
				.catch(err => Promise.reject(err.statusCode === 409 ? `${fullName} already exists.` : err))
				.then(() => log.done(`Published ${fullName}\nYour extension will live at ${getPublishedUrl(name)} (might take a few seconds for it to show up).`));
		})
		.catch(err => {
			const message = err && err.message || '';

			if (/Invalid Resource/.test(message)) {
				err.message = `${err.message}\n\nYou're likely using an expired Personal Access Token, please get a new PAT.\nMore info: https://aka.ms/vscodepat`;
			}

			return Promise.reject(err);
		});
}

export interface IPublishOptions {
	packagePath?: string;
	version?: string;
	cwd?: string;
	pat?: string;
	baseContentUrl?: string;
	baseImagesUrl?: string;
	useYarn?: boolean;
	noVerify?: boolean;
}

function versionBump(cwd: string = process.cwd(), version?: string): Promise<void> {
	if (!version) {
		return Promise.resolve(null);
	}

	switch (version) {
		case 'major':
		case 'minor':
		case 'patch':
			break;
		case 'premajor':
		case 'preminor':
		case 'prepatch':
		case 'prerelease':
		case 'from-git':
			return Promise.reject(`Not supported: ${version}`);
		default:
			if (!semver.valid(version)) {
				return Promise.reject(`Invalid version ${version}`);
			}
	}

	// call `npm version` to do our dirty work
	return exec(`npm version ${version}`, { cwd })
		.then(({ stdout, stderr }) => {
			process.stdout.write(stdout);
			process.stderr.write(stderr);
			return Promise.resolve(null);
		})
		.catch(err => Promise.reject(err.message));
}

export function publish(options: IPublishOptions = {}): Promise<any> {
	let promise: Promise<IPackage>;

	if (options.packagePath) {
		if (options.version) {
			return Promise.reject(`Not supported: packagePath and version.`);
		}

		promise = readManifestFromPackage(options.packagePath)
			.then(manifest => ({ manifest, packagePath: options.packagePath }));
	} else {
		const cwd = options.cwd;
		const baseContentUrl = options.baseContentUrl;
		const baseImagesUrl = options.baseImagesUrl;
		const useYarn = options.useYarn;

		promise = versionBump(options.cwd, options.version)
			.then(() => tmpName())
			.then(packagePath => pack({ packagePath, cwd, baseContentUrl, baseImagesUrl, useYarn }));
	}

	return promise.then(({ manifest, packagePath }) => {
		if (!options.noVerify && manifest.enableProposedApi) {
			throw new Error('Extensions using proposed API (enableProposedApi: true) can\'t be published to the Marketplace');
		}

		const patPromise = options.pat
			? Promise.resolve(options.pat)
			: getPublisher(manifest.publisher).then(p => p.pat);

		return patPromise.then(pat => _publish(packagePath, pat, manifest));
	});
}

export interface IUnpublishOptions extends IPublishOptions {
	id?: string;
}

export async function unpublish(options: IUnpublishOptions = {}): Promise<any> {
	let publisher: string, name: string;

	if (options.id) {
		[publisher, name] = options.id.split('.');
	} else {
		const manifest = await readManifest(options.cwd);
		publisher = manifest.publisher;
		name = manifest.name;
	}

	const fullName = `${publisher}.${name}`;
	const pat = options.pat || (await getPublisher(publisher)).pat;
	const api = await getGalleryAPI(pat);
	const ext = await api.getExtension(null, publisher, name);
	await api.updateExtensionProperties(publisher, name, ext.flags | PublishedExtensionFlags.Unpublished); // https://github.com/Microsoft/vscode-vsce/issues/318
	log.done(`Unpublished extension: ${fullName}!`);
}

export function deleteExtension(options: IUnpublishOptions = {}): Promise<any> {
	let promise: Promise<{ publisher: string; name: string; }>;

	if (options.id) {
		const [publisher, name] = options.id.split('.');
		promise = Promise.resolve(({ publisher, name }));
	} else {
		promise = readManifest(options.cwd);
	}

	return promise.then(({ publisher, name }) => {
		const fullName = `${publisher}.${name}`;
		const pat = options.pat
			? Promise.resolve(options.pat)
			: getPublisher(publisher).then(p => p.pat);

		return read(`This will FOREVER delete '${fullName}'! Are you sure? [y/N] `)
			.then(answer => /^y$/i.test(answer) ? null : Promise.reject('Aborted'))
			.then(() => pat)
			.then(getGalleryAPI)
			.then(api => api.deleteExtension(publisher, name))
			.then(() => log.done(`Deleted extension: ${fullName}!`));
	});
}
