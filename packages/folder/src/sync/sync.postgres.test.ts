/**
 * Sync Tests (a directory with the server's repository)
 *
 * The sync scenarios (`sync.scenarios.ts`) over two directories in Bun,
 * each keeping its manifest at `.epicenter/synced.json`, syncing with a
 * repository on the real server: Postgres, the Git and LFS disk stores,
 * and a signed-in person's token (`startRepositoryServer`). Each scenario
 * gets its own repository. Requires initdb and pg_ctl on PATH.
 *
 * Key behaviors: those of `sync.scenarios.ts`, over the wire the web and
 * the CLI use: a folder minted on the server and reached by its id,
 * attachments at their sha256, and a note's base read by its blob id.
 */
import { afterAll, beforeAll, describe, test } from 'bun:test';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { nodeStore } from '../device/node-store.js';
import { scratch } from '../scratch.test-support.js';
import { folderRepository, mintFolder } from '../remote/repository.js';
import { storeManifest } from './sync.js';
import { syncScenarios, type World } from './sync.scenarios.js';

let server: Awaited<ReturnType<typeof startRepositoryServer>>;
let account: Awaited<ReturnType<typeof server.signIn>>;
const roots: string[] = [];

beforeAll(async () => {
	server = await startRepositoryServer();
	account = await server.signIn('sync');
}, 120_000);

afterAll(async () => {
	await server?.stop();
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Every file below `root` with no hidden segment, relative and sorted. */
async function visible(root: string, prefix = ''): Promise<string[]> {
	const out: string[] = [];
	for (const entry of await readdir(join(root, prefix), {
		withFileTypes: true,
	})) {
		if (entry.name.startsWith('.')) continue;
		const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
		if (entry.isDirectory()) out.push(...(await visible(root, path)));
		else out.push(path);
	}
	return out.sort();
}

/** A directory per computer, syncing with a folder of its own on the server. */
async function directoryWorld(): Promise<World> {
	const minted = await mintFolder(account);
	if (minted.error !== null) throw new Error(minted.error.message);
	return {
		repository: folderRepository(account, minted.data.folder),
		async device() {
			const root = await scratch('epicenter-sync-');
			roots.push(root);
			const store = nodeStore(root);
			return {
				store,
				manifest: storeManifest(store),
				async write(path, content) {
					const target = join(root, path);
					if (content === null) return rm(target, { force: true });
					await mkdir(dirname(target), { recursive: true });
					await writeFile(target, content);
				},
				async read(path) {
					return readFile(join(root, path), 'utf8').catch(() => null);
				},
				paths: () => visible(root),
			};
		},
	};
}

describe('sync: a directory with the server repository', () => {
	for (const [name, run] of Object.entries(syncScenarios))
		test(name, async () => run(await directoryWorld()), 30_000);
});
