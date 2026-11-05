/**
 * Sync Tests (memory with memory)
 *
 * The sync scenarios (`sync.scenarios.ts`) over two memory stores, each
 * with a manifest in memory, syncing through a memory repository: the
 * algorithm with no disk, network, or server. Then again with each
 * computer's local side the connected folder over its memory store
 * (`localStoreOf`), which answers from what the folder holds: every
 * visible file, the contract's and any other.
 * `sync.postgres.test.ts` runs the same scenarios over directories and the
 * server's repository.
 *
 * Key behaviors: those of `sync.scenarios.ts`.
 */
import { expect, test } from 'bun:test';
import { defineContract, isHiddenPath } from '@epicenter/definition/contract';
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
					store.outside.paths().filter((path) => !isHiddenPath(path)),
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
				// The folder hears it, and its listing reads what it heard first.
				write: outside.write,
				read: async (path) => outside.read(path),
				paths: async () =>
					outside.paths().filter((path) => !isHiddenPath(path)),
			};
		},
	};
}

for (const [name, run] of Object.entries(syncScenarios))
	test(`${name} (through the open folder)`, () => run(folderWorld()));

test('the open folder as a store lists every visible file, holds only the contract as items, and never lists a hidden one', async () => {
	const place = memory();
	const outside = memoryFiles(place);
	await outside.write('AGENTS.md', '# Todos\n');
	await outside.write('mine/plan.txt', 'by hand');
	await outside.write('.DS_Store', 'finder');
	const folder = openFolder(contract, place);
	const store = localStoreOf(folder);
	expect(
		expectOk(await store.list(['']))
			.map(({ path }) => path)
			.sort(),
	).toEqual(['AGENTS.md', 'mine/plan.txt']);

	const bytes = new TextEncoder().encode('---\ntitle: "A"\n---\n');
	const landed = expectOk(
		await store.write('todos/a.md', bytes, 'absent'),
	) as Version;
	const stray = expectOk(
		await store.write('stray/b.md', bytes, 'absent'),
	) as Version;
	expect(
		expectOk(await store.write('.epicenter/x', bytes, 'absent')),
	).toBeString();
	expect(expectOk(await store.list(['todos', 'stray']))).toEqual([
		{ path: 'todos/a.md', version: landed, size: bytes.byteLength },
		{ path: 'stray/b.md', version: stray, size: bytes.byteLength },
	]);
	expect(folder.todos.items().map(({ id }) => id)).toEqual(['a']);
	// Another program's file is read from the store, and heard before the next listing.
	await outside.write('mine/plan.txt', 'edited');
	const [plan] = expectOk(await store.read(['mine/plan.txt']));
	if (plan === undefined || 'gone' in plan) throw new Error('expected a file');
	expect(new TextDecoder().decode(plan.bytes)).toBe('edited');
	expect(expectOk(await store.list(['mine']))).toEqual([
		{ path: 'mine/plan.txt', version: plan.version, size: 6 },
	]);
	expect(expectOk(await store.write('todos/a.md', null, landed))).toBeNull();
	expect(
		expectOk(await store.list(['']))
			.map(({ path }) => path)
			.sort(),
	).toEqual(['AGENTS.md', 'mine/plan.txt', 'stray/b.md']);
});
