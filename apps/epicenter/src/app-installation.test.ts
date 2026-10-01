import { expect, test } from 'bun:test';
import {
	mkdir,
	mkdtemp,
	readFile,
	rename,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import {
	discoverInstalledApplications,
	installApplication,
	readReleaseManifest,
} from './app-installation.ts';

async function releaseFixture(): Promise<{ root: string; dataRoot: string }> {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-release-'));
	const dataRoot = await mkdtemp(join(tmpdir(), 'epicenter-data-'));
	await writeFile(
		join(root, 'manifest.json'),
		JSON.stringify({
			id: 'com.example.notes',
			title: 'Notes',
			version: '1.0.0',
		}),
	);
	await writeFile(join(root, 'index.html'), '<script src="app.js"></script>');
	await writeFile(join(root, 'app.js'), 'window.notesVersion = 1;');
	return { root, dataRoot };
}

test('installs a release and discovers it from the app directory', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		const installed = await installApplication({ releaseRoot: root, dataRoot });
		expect(
			await readFile(join(installed.appRoot, 'bundle', 'app.js'), 'utf8'),
		).toContain('notesVersion');
		const discovered = await discoverInstalledApplications({ dataRoot });
		expect(discovered).toEqual([
			{
				id: 'com.example.notes',
				title: 'Notes',
				version: '1.0.0',
				bundleRoot: join(dataRoot, 'apps', 'com.example.notes', 'bundle'),
			},
		]);
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('preserves filenames when the release path is relative', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		const installed = await installApplication({
			releaseRoot: relative(process.cwd(), root),
			dataRoot,
		});
		expect(
			await readFile(join(installed.appRoot, 'bundle', 'app.js'), 'utf8'),
		).toContain('notesVersion');
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('replaces only the bundle and preserves app-owned files', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		const first = await installApplication({ releaseRoot: root, dataRoot });
		await mkdir(join(first.appRoot, 'data'), { recursive: true });
		await writeFile(join(first.appRoot, 'data', 'value.txt'), 'keep me');
		await writeFile(
			join(root, 'manifest.json'),
			JSON.stringify({
				id: 'com.example.notes',
				title: 'Notes',
				version: '2.0.0',
			}),
		);
		await writeFile(join(root, 'app.js'), 'window.notesVersion = 2;');

		await installApplication({ releaseRoot: root, dataRoot });
		expect(
			await readFile(join(first.appRoot, 'bundle', 'app.js'), 'utf8'),
		).toContain('= 2');
		expect(
			await readFile(join(first.appRoot, 'data', 'value.txt'), 'utf8'),
		).toBe('keep me');
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('rejects symlinks and malformed release identity before installation', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		const outside = await mkdtemp(join(tmpdir(), 'epicenter-release-outside-'));
		try {
			await writeFile(join(outside, 'secret.txt'), 'secret');
			await symlink(join(outside, 'secret.txt'), join(root, 'secret.txt'));
			expect(readReleaseManifest(root)).rejects.toThrow(/symlinks/);
		} finally {
			await rm(outside, { recursive: true, force: true });
		}

		await writeFile(
			join(root, 'manifest.json'),
			JSON.stringify({ id: 'notes', title: 'Notes', version: '1.0.0' }),
		);
		expect(installApplication({ releaseRoot: root, dataRoot })).rejects.toThrow(
			/valid id/,
		);
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('refuses reserved ids', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		await writeFile(
			join(root, 'manifest.json'),
			JSON.stringify({
				id: 'com.example.notes',
				title: 'Notes',
				version: '1.0.0',
			}),
		);
		expect(
			installApplication({
				releaseRoot: root,
				dataRoot,
				reservedIds: ['com.example.notes'],
			}),
		).rejects.toThrow(/reserved/);
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('refuses a release nested inside its installation directory', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		await writeFile(
			join(dataRoot, 'manifest.json'),
			JSON.stringify({
				id: 'com.example.notes',
				title: 'Notes',
				version: '1.0.0',
			}),
		);
		await writeFile(join(dataRoot, 'index.html'), '<title>Notes</title>');
		await expect(
			installApplication({ releaseRoot: dataRoot, dataRoot }),
		).rejects.toThrow(/overlap/);
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('requires index.html to be a regular file', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		await rm(join(root, 'index.html'));
		await mkdir(join(root, 'index.html'));
		expect(readReleaseManifest(root)).rejects.toThrow(/root index.html/);
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});

test('recovers a previous bundle left behind by interrupted activation', async () => {
	const { root, dataRoot } = await releaseFixture();
	try {
		const installed = await installApplication({ releaseRoot: root, dataRoot });
		const previous = join(installed.appRoot, '.previous', 'bundle');
		await mkdir(join(installed.appRoot, '.previous'), { recursive: true });
		await rename(join(installed.appRoot, 'bundle'), previous);

		const discovered = await discoverInstalledApplications({ dataRoot });
		expect(discovered).toHaveLength(1);
		expect(
			await readFile(join(installed.appRoot, 'bundle', 'index.html'), 'utf8'),
		).toContain('<script');
	} finally {
		await Promise.all([
			rm(root, { recursive: true, force: true }),
			rm(dataRoot, { recursive: true, force: true }),
		]);
	}
});
