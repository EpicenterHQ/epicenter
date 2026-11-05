/**
 * Sync Tests (memory with memory)
 *
 * The sync scenarios (`sync.scenarios.ts`) over two memory stores, each
 * with a manifest in memory, syncing through a memory repository: the
 * algorithm with no disk, network, or server. `sync.postgres.test.ts` runs
 * the same scenarios over directories and the server's repository.
 *
 * Key behaviors: those of `sync.scenarios.ts`.
 */
import { test } from 'bun:test';
import { memoryStore } from '../device/memory-store.js';
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
