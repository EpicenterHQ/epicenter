import { randomUUID } from 'node:crypto';
import type { Dirent } from 'node:fs';
import {
	copyFile,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { isAppId } from '@epicenter/constants/app-id';

const BUNDLE_DIRECTORY = 'bundle';
const MANIFEST_FILE = 'manifest.json';

export type ApplicationManifest = {
	id: string;
	title: string;
	version: string;
};

export type InstalledApplication = ApplicationManifest & {
	bundleRoot: string;
};

type FileEntry = {
	path: string;
	kind: 'file' | 'directory';
};

export async function readReleaseManifest(
	releaseRoot: string,
): Promise<ApplicationManifest> {
	const manifestPath = join(releaseRoot, MANIFEST_FILE);
	const manifest = parseManifest(
		await readFile(manifestPath, 'utf8').catch(() => {
			throw new Error(`Release manifest is missing: ${manifestPath}`);
		}),
	);
	await validateReadyTree(releaseRoot, 'Application release');
	return manifest;
}

export async function installApplication({
	releaseRoot,
	dataRoot,
	reservedIds = [],
}: {
	releaseRoot: string;
	dataRoot: string;
	reservedIds?: readonly string[];
}): Promise<{ manifest: ApplicationManifest; appRoot: string }> {
	const manifest = await readReleaseManifest(releaseRoot);
	if (reservedIds.includes(manifest.id)) {
		throw new Error(`The app id '${manifest.id}' is reserved by Epicenter.`);
	}

	const appsRoot = join(dataRoot, 'apps');
	const appRoot = join(appsRoot, manifest.id);
	assertNoPathOverlap(releaseRoot, appRoot);
	await mkdir(appsRoot, { recursive: true });
	const releaseLock = await acquireInstallationLock(appsRoot, manifest.id);
	const temporaryRoot = join(
		appsRoot,
		`.${manifest.id}.install-${randomUUID()}`,
	);

	try {
		await mkdir(temporaryRoot, { recursive: true });
		await copyTree(releaseRoot, join(temporaryRoot, BUNDLE_DIRECTORY));
		await validateReadyTree(
			join(temporaryRoot, BUNDLE_DIRECTORY),
			'Application bundle',
		);
		await activateInstallation({ temporaryRoot, appRoot });
	} finally {
		await rm(temporaryRoot, { recursive: true, force: true });
		await releaseLock();
	}

	return { manifest, appRoot };
}

export async function discoverInstalledApplications({
	dataRoot,
	reservedIds = [],
}: {
	dataRoot: string;
	reservedIds?: readonly string[];
}): Promise<InstalledApplication[]> {
	const appsRoot = join(dataRoot, 'apps');
	let entries: Dirent[];
	try {
		entries = await readdir(appsRoot, { withFileTypes: true });
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return [];
		throw cause;
	}
	const applications: InstalledApplication[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
		const appRoot = join(appsRoot, entry.name);
		await recoverPreviousBundle(appRoot);
		const bundleRoot = join(appRoot, BUNDLE_DIRECTORY);
		const bundle = await lstat(bundleRoot).catch(() => undefined);
		// Compiled apps may already own data below apps/<id> without being
		// installed applications. Only a host-owned bundle marks an installation.
		if (bundle === undefined) continue;
		if (!bundle.isDirectory()) {
			throw new Error(`Installed app bundle is not a directory: ${bundleRoot}`);
		}
		const manifest = parseManifest(
			await readFile(join(bundleRoot, MANIFEST_FILE), 'utf8').catch(() => {
				throw new Error(`Installed app manifest is missing: ${appRoot}`);
			}),
		);
		if (manifest.id !== entry.name) {
			throw new Error(
				`Installed app manifest id '${manifest.id}' does not match '${entry.name}'.`,
			);
		}
		if (reservedIds.includes(manifest.id)) {
			throw new Error(
				`Installed app id '${manifest.id}' is reserved by Epicenter.`,
			);
		}
		await validateReadyTree(bundleRoot, 'Application bundle');
		applications.push({
			...manifest,
			bundleRoot,
		});
	}

	return applications.sort((left, right) => left.id.localeCompare(right.id));
}

function parseManifest(contents: string): ApplicationManifest {
	let value: unknown;
	try {
		value = JSON.parse(contents);
	} catch {
		throw new Error('Application manifest must be valid JSON.');
	}
	if (!isRecord(value))
		throw new Error('Application manifest must be an object.');
	const { id, title, version } = value;
	if (
		typeof id !== 'string' ||
		!isAppId(id) ||
		typeof title !== 'string' ||
		title.trim() === '' ||
		typeof version !== 'string' ||
		version.trim() === ''
	) {
		throw new Error(
			'Application manifest must contain a valid id, title, and version.',
		);
	}
	return { id, title, version };
}

async function validateReadyTree(root: string, label: string): Promise<void> {
	const entries = await collectEntries(root);
	if (
		!entries.some(
			(entry) =>
				entry.path === join(root, 'index.html') && entry.kind === 'file',
		)
	) {
		throw new Error(`${label} is missing its root index.html: ${root}`);
	}
}

async function collectEntries(root: string): Promise<FileEntry[]> {
	const entries: FileEntry[] = [];
	const visit = async (directory: string): Promise<void> => {
		const children = await readdir(directory, { withFileTypes: true }).catch(
			() => {
				throw new Error(`Application bundle is missing: ${root}`);
			},
		);
		for (const child of children) {
			const path = join(directory, child.name);
			if (child.isSymbolicLink()) {
				throw new Error(`Application bundle cannot contain symlinks: ${path}`);
			}
			if (child.isDirectory()) {
				entries.push({ path, kind: 'directory' });
				await visit(path);
				continue;
			}
			if (child.isFile()) {
				entries.push({ path, kind: 'file' });
				continue;
			}
			throw new Error(
				`Application bundle contains an unsupported file: ${path}`,
			);
		}
	};
	await visit(root);
	return entries;
}

async function copyTree(
	sourceRoot: string,
	destinationRoot: string,
): Promise<void> {
	sourceRoot = resolve(sourceRoot);
	await mkdir(destinationRoot, { recursive: true });
	const entries = await collectEntries(sourceRoot);
	for (const entry of entries) {
		const destination = join(
			destinationRoot,
			relativePath(sourceRoot, entry.path),
		);
		if (entry.kind === 'directory') {
			await mkdir(destination, { recursive: true });
		} else {
			await copyFile(entry.path, destination);
		}
	}
}

async function activateInstallation({
	temporaryRoot,
	appRoot,
}: {
	temporaryRoot: string;
	appRoot: string;
}): Promise<void> {
	const existing = await lstat(appRoot).catch(() => undefined);
	if (existing === undefined) {
		await rename(temporaryRoot, appRoot);
		return;
	}
	if (!existing.isDirectory()) {
		throw new Error(`Installed app path is not a directory: ${appRoot}`);
	}

	const backupRoot = join(appRoot, '.previous');
	await recoverPreviousBundle(appRoot);
	await rm(backupRoot, { recursive: true, force: true });
	await mkdir(backupRoot);
	let movedPrevious = false;
	let activated = false;
	let restored = false;
	try {
		const existingBundle = await lstat(join(appRoot, BUNDLE_DIRECTORY)).catch(
			() => undefined,
		);
		if (existingBundle !== undefined) {
			if (!existingBundle.isDirectory()) {
				throw new Error(`Installed app bundle is not a directory: ${appRoot}`);
			}
			await rename(
				join(appRoot, BUNDLE_DIRECTORY),
				join(backupRoot, BUNDLE_DIRECTORY),
			);
			movedPrevious = true;
		}
		await rename(
			join(temporaryRoot, BUNDLE_DIRECTORY),
			join(appRoot, BUNDLE_DIRECTORY),
		);
		activated = true;
	} catch (cause) {
		await rm(join(appRoot, BUNDLE_DIRECTORY), { recursive: true, force: true });
		if (movedPrevious) {
			await rename(
				join(backupRoot, BUNDLE_DIRECTORY),
				join(appRoot, BUNDLE_DIRECTORY),
			);
			restored = true;
		}
		throw cause;
	} finally {
		if (activated || restored || !movedPrevious) {
			await rm(backupRoot, { recursive: true, force: true });
		}
	}
}

async function recoverPreviousBundle(appRoot: string): Promise<void> {
	const previous = join(appRoot, '.previous', BUNDLE_DIRECTORY);
	const active = join(appRoot, BUNDLE_DIRECTORY);
	const previousBundle = await lstat(previous).catch(() => undefined);
	if (previousBundle === undefined) return;
	const activeBundle = await lstat(active).catch(() => undefined);
	if (activeBundle === undefined) {
		await rename(previous, active);
		return;
	}
	await rm(previous, { recursive: true, force: true });
}

function relativePath(root: string, path: string): string {
	const result = relative(root, path);
	if (result === '' || result.startsWith(`..${sep}`) || isAbsolute(result)) {
		throw new Error(`Application entry escapes its release folder: ${path}`);
	}
	return result;
}

async function acquireInstallationLock(
	appsRoot: string,
	appId: string,
): Promise<() => Promise<void>> {
	const lockRoot = join(appsRoot, `.${appId}.install-lock`);
	try {
		await mkdir(lockRoot);
	} catch (cause) {
		if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause;
		const pid = Number.parseInt(
			await readFile(join(lockRoot, 'pid'), 'utf8').catch(() => ''),
			10,
		);
		if (Number.isInteger(pid)) {
			try {
				process.kill(pid, 0);
				throw new Error(`Installation for '${appId}' is already running.`);
			} catch (error) {
				if (
					error instanceof Error &&
					error.message.includes('already running')
				) {
					throw error;
				}
			}
		}
		await rm(lockRoot, { recursive: true, force: true });
		return acquireInstallationLock(appsRoot, appId);
	}
	await writeFile(join(lockRoot, 'pid'), String(process.pid), 'utf8');
	return async () => {
		await rm(lockRoot, { recursive: true, force: true });
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNoPathOverlap(source: string, destination: string): void {
	const sourceRoot = resolve(source);
	const destinationRoot = resolve(destination);
	if (!isAbsolute(sourceRoot) || !isAbsolute(destinationRoot)) {
		throw new Error('Release and installation paths must be absolute.');
	}
	if (
		isContained(sourceRoot, destinationRoot) ||
		isContained(destinationRoot, sourceRoot)
	) {
		throw new Error(
			'The release folder cannot overlap its installation folder.',
		);
	}
}

function isContained(root: string, path: string): boolean {
	const fromRoot = relative(root, path);
	return (
		fromRoot === '' ||
		(fromRoot !== '..' &&
			!fromRoot.startsWith(`..${sep}`) &&
			!isAbsolute(fromRoot))
	);
}
