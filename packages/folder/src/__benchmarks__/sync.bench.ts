/**
 * `sync` at 10,000 notes, timed as ADR-0751 timed the Rust core's rounds:
 * first sync (push everything), unchanged, 10 edits, restore (an empty
 * folder pulls everything), and merge (10 notes changed on both sides).
 * Three worlds: memory stores with a memory repository (the algorithm
 * alone), directories in Bun with the server's repository on Postgres (what
 * the CLI does), and the same directories opened as folders, syncing
 * through `localStoreOf` (what an app does: its local side is what the
 * folder already holds).
 *
 *   bun src/__benchmarks__/sync.bench.ts
 *
 * Each row also splits the time by where it went: the local store, the
 * repository, the manifest, and the rest (planning and merging).
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { defineContract } from '@epicenter/definition/contract';
import { startRepositoryServer } from '../../../server/src/test-helpers/repository-server.js';
import { memoryStore } from '../device/memory-store.js';
import { nodeStore } from '../device/node-store.js';
import type { Store } from '../device/store.js';
import { localStoreOf } from '../folder.js';
import { directory } from '../node.js';
import { openFolder } from '../open-folder.js';
import { folderRepository, makeFolder } from '../remote/repository.js';
import { scratch } from '../scratch.test-support.js';
import { memoryRepository, type Repository } from '../sync/repository.js';
import {
	type ManifestStore,
	memoryManifest,
	storeManifest,
	sync,
} from '../sync/sync.js';

const COUNT = 10_000;
const EDITS = 10;
const UNCHANGED_RUNS = 5;

const idOf = (index: number) => String(index).padStart(5, '0');
const pathOf = (index: number) => `todos/${idOf(index)}.md`;
const noteOf = (index: number, title = `Todo ${index}`) =>
	`---\ntitle: ${JSON.stringify(title)}\ndone: ${index % 3 === 0}\ntags: ["bench"]\n---\nA body for todo ${index}.\nIt has a second line.\n`;

/** Time spent in each of an object's async methods, summed. */
function timed<T extends object>(target: T, spent: { ms: number }): T {
	return new Proxy(target, {
		get(object, key) {
			const value = Reflect.get(object, key);
			if (typeof value !== 'function') return value;
			return async (...args: unknown[]) => {
				const start = performance.now();
				try {
					return await value.apply(object, args);
				} finally {
					spent.ms += performance.now() - start;
				}
			};
		},
	});
}

type Device = {
	store: Store;
	manifest: ManifestStore;
	write(path: string, text: string): Promise<void>;
	/** Wait until the device has heard what `write` did outside it, before a sync is timed. */
	settle?(): Promise<void>;
};

type World = {
	name: string;
	repository: Repository;
	device(): Promise<Device>;
	stop(): Promise<void>;
};

async function memoryWorld(): Promise<World> {
	return {
		name: 'memory with memory',
		repository: memoryRepository(),
		async device() {
			const store = memoryStore();
			return {
				store,
				manifest: memoryManifest(),
				write: (path, text) => store.outside.write(path, text),
			};
		},
		async stop() {},
	};
}

const contract = defineContract({
	collections: { todos: { path: 'todos/{id}.md' } },
});

async function serverWorld(asFolder: boolean): Promise<World> {
	const server = await startRepositoryServer();
	const account = await server.signIn('bench');
	const made = await makeFolder(account);
	if (made.error !== null) throw new Error(made.error.message);
	const folder = made.data;
	const roots: string[] = [];
	const folders: Disposable[] = [];
	return {
		name: asFolder
			? 'open folder over a directory with the server'
			: 'directory with the server',
		repository: folderRepository(account, folder),
		async device() {
			const root = await scratch('epicenter-sync-bench-');
			roots.push(root);
			const store = nodeStore(root);
			const write = async (path: string, text: string) => {
				const target = join(root, path);
				await mkdir(dirname(target), { recursive: true });
				await writeFile(target, text);
			};
			// The manifest is kept outside the folder, as a record is.
			const manifest = storeManifest(nodeStore(`${root}-records`), 'synced.json');
			roots.push(`${root}-records`);
			if (!asFolder) return { store, manifest, write };
			const folder = openFolder(contract, directory(root));
			folders.push(folder);
			return {
				store: localStoreOf(folder),
				manifest,
				write,
				// List again what the watcher may not have delivered yet.
				settle: async () => {
					await folder.todos.list();
				},
			};
		},
		async stop() {
			for (const folder of folders) folder[Symbol.dispose]();
			for (const root of roots)
				await rm(root, { recursive: true, force: true });
			await server.stop();
		},
	};
}

type Row = {
	sync: string;
	seconds: string;
	local: string;
	repository: string;
	manifest: string;
	rest: string;
	note: string;
};

async function measure(world: World) {
	const rows: Row[] = [];
	async function run(label: string, device: Device, note = '') {
		await device.settle?.();
		const spent = { local: { ms: 0 }, remote: { ms: 0 }, manifest: { ms: 0 } };
		const start = performance.now();
		const report = await sync({
			local: timed(device.store, spent.local),
			remote: timed(world.repository, spent.remote),
			manifest: timed(device.manifest, spent.manifest),
		});
		const total = performance.now() - start;
		if (report.error !== null) throw new Error(JSON.stringify(report.error));
		const s = (ms: number) => (ms / 1000).toFixed(2);
		rows.push({
			sync: label,
			seconds: s(total),
			local: s(spent.local.ms),
			repository: s(spent.remote.ms),
			manifest: s(spent.manifest.ms),
			rest: s(total - spent.local.ms - spent.remote.ms - spent.manifest.ms),
			note:
				note ||
				`${report.data.pushed.length} pushed, ${report.data.pulled.length} pulled, ${report.data.merged.length} merged`,
		});
		return report.data;
	}

	const a = await world.device();
	for (let index = 0; index < COUNT; index++)
		await a.write(pathOf(index), noteOf(index));
	await run('first sync', a);
	await run('second (agrees on the pushed changes)', a);
	for (let index = 0; index < UNCHANGED_RUNS; index++)
		await run('unchanged', a, `run ${index + 1}`);
	for (let index = 0; index < EDITS; index++)
		await a.write(pathOf(index * 997), noteOf(index * 997, `Edited ${index}`));
	await run('10 edits', a);
	const b = await world.device();
	await run('restore', b);
	for (let index = 0; index < EDITS; index++) {
		const at = index * 991;
		await a.write(pathOf(at), noteOf(at, `From A ${index}`));
		await b.write(
			pathOf(at),
			noteOf(at).replace(
				'It has a second line.',
				`B changed line two ${index}.`,
			),
		);
	}
	await run('push before merge', a);
	await run('merge', b);
	return rows;
}

for (const make of [
	memoryWorld,
	() => serverWorld(false),
	() => serverWorld(true),
]) {
	const world = await make();
	try {
		const rows = await measure(world);
		console.log(`\n${world.name}, ${COUNT} notes (seconds)`);
		console.table(rows);
	} finally {
		await world.stop();
	}
}
