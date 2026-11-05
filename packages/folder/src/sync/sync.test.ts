/**
 * Sync Tests (memory with memory)
 *
 * The sync scenarios (`sync.scenarios.ts`) over two memory stores, each
 * with a manifest in memory, syncing through a memory repository: the
 * algorithm with no disk, network, or server. Then again with each
 * computer's local side the connected folder over its memory store
 * (`localStoreOf`), which answers from what the folder holds.
 * `sync.postgres.test.ts` runs the same scenarios over directories and the
 * server's repository.
 *
 * Key behaviors: those of `sync.scenarios.ts`.
 */
import { expect, test } from 'bun:test';
import { defineContract } from '@epicenter/definition/contract';
import { expectOk } from 'wellcrafted/testing';
import { memoryStore } from '../device/memory-store.js';
import type { Version } from '../device/store.js';
import { localStoreOf } from '../folder.js';
import { memory, memoryFiles } from '../memory.js';
import { openFolder } from '../open-folder.js';
import { memoryRepository } from './repository.js';
import { memoryManifest } from './sync.js';
import { syncScenarios, type World } from './sync.scenarios.js';

function memoryWorld(): World {
	return {
		repository: memoryRepository(),
		async device() {
			const store = memoryStore();
			return {
				store,
				manifest: memoryManifest(),
				write: store.outside.write,
				read: async (path) => store.outside.read(path),
				paths: async () =>
					store.outside.paths().filter((path) => !path.startsWith('.')),
			};
		},
	};
}

for (const [name, run] of Object.entries(syncScenarios))
	test(name, () => run(memoryWorld()));

const contract = defineContract({
	collections: {
		todos: { path: 'todos/{id}.md' },
		audio: { path: 'audio/{id}.{ext}' },
	},
});

/** Computers whose local side is an open folder over memory: another program's write is heard before the next sync. */
function folderWorld(): World {
	return {
		repository: memoryRepository(),
		async device() {
			const place = memory();
			const folder = openFolder(contract, place);
			const outside = memoryFiles(place);
			return {
				store: localStoreOf(folder),
				manifest: memoryManifest(),
				async write(path, content) {
					await outside.write(path, content);
					// The folder lists again what it heard, as its own refresh does.
					await folder.todos.list();
					await folder.audio.list();
				},
				read: async (path) => outside.read(path),
				paths: async () =>
					outside.paths().filter((path) => !path.startsWith('.')),
			};
		},
	};
}

for (const [name, run] of Object.entries(syncScenarios))
	test(`${name} (through the open folder)`, () => run(folderWorld()));

test('the open folder as a store holds the contract: a path outside it is stale, and a write it makes is listed at once', async () => {
	const place = memory();
	const folder = openFolder(contract, place);
	const store = localStoreOf(folder);
	expectOk(await store.list(['']));
	const bytes = new TextEncoder().encode('---\ntitle: "A"\n---\n');
	expect(expectOk(await store.write('stray/a.md', bytes, 'absent'))).toBe(
		'stale',
	);
	expect(memoryFiles(place).paths()).toEqual([]);
	const landed = expectOk(
		await store.write('todos/a.md', bytes, 'absent'),
	) as Version;
	expect(landed).toBeString();
	expect(expectOk(await store.list(['todos']))).toEqual([
		{ path: 'todos/a.md', version: landed, size: bytes.byteLength },
	]);
	const [read] = expectOk(await store.read(['todos/a.md']));
	expect(read).toEqual({ path: 'todos/a.md', bytes, version: landed });
	expect(expectOk(await store.write('todos/a.md', null, landed))).toBeNull();
	expect(expectOk(await store.list(['']))).toEqual([]);
});
