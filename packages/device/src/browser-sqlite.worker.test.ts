/**
 * SQLite worker address isolation.
 *
 * Drives the real request handler against a recording pool. Each probe runs in
 * a separate Bun process so its WASM mock cannot affect other test files.
 * This verifies filenames and delete routing, not OPFS durability or contention.
 */
import { expect, test } from 'bun:test';
import type { StorageScope } from './protocol.js';

async function deleteFiles(
	requests: { appId: string; scope: StorageScope; name: string }[],
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
				await self.onmessage({ data: { id, request: { kind: 'sqlite-delete', ...request } } });
			}
			if (replies.some(reply => reply.response?.kind !== 'sqlite-delete')) {
				throw new Error(JSON.stringify(replies));
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

test('authority and principal separators cannot alias another account file', async () => {
	const scopes: StorageScope[] = [
		{ kind: 'account', authorityId: 'one:two', principalId: 'three' },
		{ kind: 'account', authorityId: 'one', principalId: 'two:three' },
		{ kind: 'account', authorityId: 'one-two', principalId: 'three' },
		{ kind: 'account', authorityId: 'one', principalId: 'two-three' },
	];
	const files = await deleteFiles(
		scopes.map((scope) => ({ appId, scope, name: 'search' })),
	);
	expect(new Set(files).size).toBe(scopes.length * 2);
});

test('local, authority, application, and database identity select independent files', async () => {
	const files = await deleteFiles([
		{ appId, scope: { kind: 'local' }, name: 'search' },
		{
			appId,
			scope: { kind: 'account', authorityId: 'local', principalId: 'alice' },
			name: 'search',
		},
		{
			appId,
			scope: { kind: 'account', authorityId: 'other', principalId: 'alice' },
			name: 'search',
		},
		{ appId: 'so.epicenter.another', scope: { kind: 'local' }, name: 'search' },
		{ appId, scope: { kind: 'local' }, name: 'other' },
	]);
	expect(new Set(files).size).toBe(10);
});

test('repeated deletion targets the same database and its own journal', async () => {
	const request = {
		appId,
		scope: {
			kind: 'account',
			authorityId: 'a:%"',
			principalId: 'b:[]',
		} as const,
		name: 'search',
	};
	const files = await deleteFiles([request, request]);
	expect(files).toHaveLength(4);
	expect(files[0]).toBe(files[2]);
	expect(files[1]).toBe(`${files[0]}-journal`);
	expect(files[3]).toBe(files[1]);
	expect(files[0]?.split('/')).toHaveLength(2);
	expect(files[0]?.endsWith('.sqlite')).toBe(true);
});
