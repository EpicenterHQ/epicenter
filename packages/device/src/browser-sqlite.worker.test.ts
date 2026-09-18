/**
 * SQLite worker address isolation.
 *
 * Drives the real request handler against a recording pool. Each probe runs in
 * a separate Bun process so its WASM mock cannot affect other test files.
 * This verifies filenames and delete routing, not OPFS durability or contention.
 */
import { expect, test } from 'bun:test';

async function deleteFiles(
	requests: {
		appId: string;
		name: string;
	}[],
): Promise<string[]> {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			'--eval',
			`
			import { mock } from 'bun:test';
			const files = [];
			const replies = [];
			mock.module('@sqlite.org/sqlite-wasm', () => ({
				default: async () => ({
					installOpfsSAHPoolVfs: async () => ({
						unlink(file) { files.push(file); return true; },
					}),
				}),
			}));
			globalThis.self = { postMessage(reply) { replies.push(reply); } };
			await import(${JSON.stringify(new URL('./browser-sqlite.worker.ts', import.meta.url).href)});
            for (const [id, request] of ${JSON.stringify(requests)}.entries()) {
                await self.onmessage({ data: { id, request: { kind: 'sqlite-acquire', appId: request.appId } } });
                const lifetimeId = replies.at(-1).response?.lifetimeId;
                if (!lifetimeId) throw new Error(JSON.stringify(replies));
                await self.onmessage({ data: { id, request: { kind: 'sqlite-delete', ...request, lifetimeId } } });
                if (replies.at(-1).response?.kind !== 'sqlite-delete') throw new Error(JSON.stringify(replies));
                await self.onmessage({ data: { id, request: { kind: 'sqlite-close', ...request, lifetimeId } } });
            }
			console.log(JSON.stringify(files));
			`,
		],
		cwd: import.meta.dir,
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect(stderr).toBe('');
	expect(exitCode).toBe(0);
	return JSON.parse(stdout);
}

const appId = 'so.epicenter.worker-test';

test('application and database names select independent files', async () => {
	const files = await deleteFiles([
		{ appId, name: 'search' },
		{ appId: 'so.epicenter.other', name: 'search' },
		{ appId, name: 'other' },
	]);
	expect(new Set(files).size).toBe(6);
});

test('reopening targets the same database and its own journal', async () => {
	const request = { appId, name: 'search' };
	const files = await deleteFiles([request, request]);
	expect(files).toEqual([
		`/${encodeURIComponent(JSON.stringify([appId, 'no-account', 'search']))}.sqlite`,
		`/${encodeURIComponent(JSON.stringify([appId, 'no-account', 'search']))}.sqlite-journal`,
		`/${encodeURIComponent(JSON.stringify([appId, 'no-account', 'search']))}.sqlite`,
		`/${encodeURIComponent(JSON.stringify([appId, 'no-account', 'search']))}.sqlite-journal`,
	]);
});
