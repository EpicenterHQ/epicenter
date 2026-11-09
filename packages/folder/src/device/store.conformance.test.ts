/**
 * The store conformance checks (`store.conformance.ts`) over every store
 * Bun can run: memory, a directory, the desktop shell's commands over an
 * emulated shell whose watcher is a directory watch, and a directory a
 * program serves (`served/`) over HTTP. The repository runs them in
 * `remote.postgres.test.ts`.
 */
import { afterAll, describe, mock, test } from 'bun:test';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { scratch } from '../scratch.test-support.js';
import { createNamedShell } from '../named-shell.test-support.js';
import { watchDirectory } from '../native/watch.js';
import { memoryStore } from './memory-store.js';
import { serveDirectory } from '../serve.js';
import { servedStore } from '../served/store.js';
import { nodeStore } from './node-store.js';
import { type StoreSubject, storeChecks } from './store.conformance.js';

const roots: string[] = [];
const stops: (() => Promise<unknown>)[] = [];
afterAll(async () => {
	for (const stop of stops) await stop();
	for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Another program's write of a directory: whole, by a rename, as an editor saves. */
function outsideOf(root: string) {
	return async (path: string, bytes: Uint8Array | null) => {
		const target = join(root, path);
		if (bytes === null) return rm(target, { force: true });
		await mkdir(dirname(target), { recursive: true });
		const staged = `${target}.${Math.random().toString(36).slice(2)}.tmp`;
		await writeFile(staged, bytes);
		await rename(staged, target);
	};
}

let shell: ReturnType<typeof createNamedShell> | undefined;
mock.module('@tauri-apps/api/core', () => ({
	transformCallback: () => 0,
	invoke: (cmd: string, body?: Record<string, unknown> | Uint8Array, options?: { headers?: Record<string, string> }) => {
		if (shell === undefined) throw new Error('no shell');
		return shell.invoke(cmd, body, options);
	},
}));
const { tauriStore } = await import('./tauri-store.js');

const subjects: Record<string, () => Promise<StoreSubject>> = {
	async memory() {
		const store = memoryStore();
		return {
			store,
			outside: (path, bytes) => store.outside.write(path, bytes),
		};
	},
	async directory() {
		const root = await scratch('conformance-node-');
		roots.push(root);
		return { store: nodeStore(root), outside: outsideOf(root) };
	},
	async 'desktop shell'() {
		const root = await scratch('conformance-tauri-');
		roots.push(root);
		shell = createNamedShell({ Data: root });
		await shell.invoke('plugin:epicenter-folder|open_root', { root: 'Data' });
		// The shell's watcher of the root, listening once the root opened.
		const listeners = new Set<Parameters<typeof watchDirectory>[1]>();
		await watchDirectory(root, (paths) => {
			for (const listener of listeners) listener(paths);
		});
		const store = tauriStore({
			root: 'Data',
			listen(changed) {
				listeners.add(changed);
				return () => listeners.delete(changed);
			},
		});
		return { store, outside: outsideOf(root) };
	},
	async 'served directory'() {
		const root = await scratch('conformance-served-');
		roots.push(root);
		const directory = serveDirectory(root);
		const server = Bun.serve({
			hostname: '127.0.0.1',
			port: 0,
			fetch: directory.fetch,
		});
		stops.push(async () => {
			directory.close();
			await server.stop(true);
		});
		return {
			store: servedStore(`http://127.0.0.1:${server.port}/folder`),
			outside: outsideOf(root),
		};
	},
};

for (const [name, subject] of Object.entries(subjects))
	describe(`a store: ${name}`, () => {
		for (const [check, run] of Object.entries(storeChecks))
			test(check, async () => run(await subject()), 30_000);
	});
