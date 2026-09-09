/**
 * SQLite worker address isolation.
 *
 * Drives the real request handler against a recording pool. Each probe runs in
 * a separate Bun process so its WASM mock cannot affect other test files.
 * This verifies filenames and delete routing, not OPFS durability or contention.
 */
import { expect, test } from 'bun:test';
import { type AccountIdentity, asPrincipalId } from '@epicenter/principal';

async function deleteFiles(
	requests: { appId: string; account: AccountIdentity | null; name: string }[],
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
                await self.onmessage({ data: { id, request: { kind: 'sqlite-acquire', appId: request.appId, account: request.account } } });
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

test('authority and principal separators cannot alias another account file', async () => {
	const accounts: AccountIdentity[] = [
		{ authorityId: 'one:two', principalId: asPrincipalId('three') },
		{ authorityId: 'one', principalId: asPrincipalId('two:three') },
		{ authorityId: 'one-two', principalId: asPrincipalId('three') },
		{ authorityId: 'one', principalId: asPrincipalId('two-three') },
	];
	const files = await deleteFiles(
		accounts.map((account) => ({ appId, account, name: 'search' })),
	);
	expect(new Set(files).size).toBe(accounts.length * 2);
});

test('local, authority, application, and database identity select independent files', async () => {
	const files = await deleteFiles([
		{ appId, account: null, name: 'search' },
		{
			appId,
			account: { authorityId: 'local', principalId: asPrincipalId('alice') },
			name: 'search',
		},
		{
			appId,
			account: { authorityId: 'other', principalId: asPrincipalId('alice') },
			name: 'search',
		},
		{ appId: 'so.epicenter.another', account: null, name: 'search' },
		{ appId, account: null, name: 'other' },
	]);
	expect(new Set(files).size).toBe(10);
});

test('repeated deletion targets the same database and its own journal', async () => {
	const request = {
		appId,
		account: {
			authorityId: 'a:%"',
			principalId: asPrincipalId('b:[]'),
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

test('physical filenames preserve the existing serialized tuples', async () => {
	const files = await deleteFiles([
		{ appId, account: null, name: 'search' },
		{
			appId,
			account: { authorityId: 'cloud', principalId: asPrincipalId('alice') },
			name: 'search',
		},
	]);
	expect(files).toEqual([
		`/${encodeURIComponent(JSON.stringify([appId, 'local', 'search']))}.sqlite`,
		`/${encodeURIComponent(JSON.stringify([appId, 'local', 'search']))}.sqlite-journal`,
		`/${encodeURIComponent(JSON.stringify([appId, 'account', 'cloud', 'alice', 'search']))}.sqlite`,
		`/${encodeURIComponent(JSON.stringify([appId, 'account', 'cloud', 'alice', 'search']))}.sqlite-journal`,
	]);
});
