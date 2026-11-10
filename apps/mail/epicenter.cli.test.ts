/**
 * The real CLI runs every call in a fresh process against a copied Mail app.
 * Only saved views commit; SQLite state survives calls and mirror cache wipes.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn } from '../../packages/cli/src/runner.test-support.js';
import { messages } from './lib/fixture.js';

setDefaultTimeout(60_000);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const paths = [
		'.gitignore',
		'epicenter.ts',
		...(await readdir(join(import.meta.dir, 'lib')))
			.filter((p) => p.endsWith('.ts') && !p.endsWith('.test.ts'))
			.map((p) => `lib/${p}`),
	];
	const files = Object.fromEntries(
		await Promise.all(
			paths.map(async (path) => [
				path,
				await Bun.file(join(import.meta.dir, path)).text(),
			]),
		),
	);
	const dir = await f.folder(join(f.home, 'mail'), files);
	const json = async (...args: string[]) => {
		const result = await f.run('mail', ...args, '--json');
		expect(result.code).toBe(0);
		return JSON.parse(result.stdout).returned;
	};
	return { ...f, dir, json };
}
const status = (dir: string) =>
	gitIn(dir, 'status', '--porcelain', '--untracked-files=all');
const count = (dir: string) => gitIn(dir, 'rev-list', '--count', 'HEAD');

test('CLI changes only saved-view history and retains delivery across process and cache restarts', async () => {
	const f = await setup();
	const initial = Number(await count(f.dir));
	const id = messages[0]!.id;
	expect(await f.json('refresh')).toMatchObject({ messages: 24, pending: 0 });
	expect(await status(f.dir)).toBe('');
	expect(Number(await count(f.dir))).toBe(initial);
	expect(await Bun.file(join(f.dir, '.cache/mirror.sqlite')).exists()).toBe(
		true,
	);
	expect(
		await Bun.file(join(f.dir, 'fixture-gmail.local.sqlite')).exists(),
	).toBe(true);
	const sender = await f.json('search', 'from:orders@example.com');
	expect(sender.messages.map((m: { id: string }) => m.id)).toEqual(
		messages
			.slice(0, 4)
			.reverse()
			.map((m) => m.id),
	);
	const unread = await f.json('search', 'label:receipts is:unread');
	expect(unread.messages.map((m: { id: string }) => m.id)).toEqual(
		[6, 4, 2, 0].map((i) => messages[i]!.id),
	);
	await f.json(
		'views',
		'add',
		'--input',
		JSON.stringify({
			name: 'receipts',
			query: 'label:receipts',
			title: 'Receipts',
		}),
	);
	expect(Number(await count(f.dir))).toBe(initial + 1);
	expect(await gitIn(f.dir, 'show', '--name-only', '--format=', 'HEAD')).toBe(
		'views/receipts.md',
	);
	const saved = await f.json('search', '--view', 'receipts');
	expect(saved.total).toBe(8);
	expect(saved.view).toEqual({ path: 'views/receipts.md', title: 'Receipts' });
	expect(
		(
			await f.json(
				'search',
				'--view',
				'views/receipts.md',
				'--query',
				'is:unread',
			)
		).total,
	).toBe(4);
	await f.json('label', id, '--add', 'starred');
	expect(Number(await count(f.dir))).toBe(initial + 1);
	expect(await status(f.dir)).toBe('');
	const pending = await f.json('search', 'is:starred is:pending');
	expect(pending.messages.map((m: { id: string }) => m.id)).toEqual([id]);
	expect(pending.messages[0]).toMatchObject({
		starred: true,
		pending: [{ id: 'STARRED', want: true }],
	});
	expect(await f.json('status')).toMatchObject({ pending: 1 });
	const delivered = await f.json('reconcile');
	expect(delivered.delivered).toEqual([
		{ id, added: ['STARRED'], removed: [] },
	]);
	expect(delivered.pending).toBe(0);
	expect(Number(await count(f.dir))).toBe(initial + 1);
	expect(await status(f.dir)).toBe('');
	await rm(join(f.dir, '.cache'), { recursive: true });
	await f.json('refresh');
	expect(await f.json('show', id)).toMatchObject({
		starred: true,
		pending: [],
	});
	expect(Number(await count(f.dir))).toBe(initial + 1);
	expect(await status(f.dir)).toBe('');
});

test('CLI search before a first refresh reports a null refresh time', async () => {
	const f = await setup();
	expect(await f.json('search')).toMatchObject({
		refreshedAt: null,
		messages: [],
		total: 0,
	});
	expect(await status(f.dir)).toBe('');
	expect(await count(f.dir)).toBe('1');
});
