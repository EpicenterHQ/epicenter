/**
 * Real CLI processes commit consumed drafts and final send records together.
 * Successful and refused calls leave tracked files clean; provider state stays local.
 */
import { afterEach, expect, setDefaultTimeout, test } from 'bun:test';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, gitIn } from '../../packages/cli/src/runner.test-support.ts';

setDefaultTimeout(120_000);
const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
async function setup() {
	const f = await fixture();
	roots.push(f.root);
	const files: Record<string, string> = {};
	for (const path of ['epicenter.ts', 'beeper.ts', '.gitignore'])
		files[path] = await readFile(join(import.meta.dir, path), 'utf8');
	const dir = await f.folder(join(f.home, 'messages'), files);
	const json = async (...args: string[]) => {
		const result = await f.run('messages', ...args, '--json');
		expect(await gitIn(dir, 'status', '--porcelain')).toBe('');
		return { ...result, answer: JSON.parse(result.stdout) };
	};
	const state = async (): Promise<{
		messages: { chat: string; text: string }[];
	}> => JSON.parse(await readFile(join(dir, 'beeper-demo.local.json'), 'utf8'));
	const subject = () => gitIn(dir, 'log', '-1', '--format=%s');
	const changedPaths = () =>
		gitIn(dir, 'show', '--name-only', '--format=', 'HEAD');
	return { ...f, dir, json, state, subject, changedPaths };
}

test('CLI draft survives a fresh process and send commits draft plus send, never fictional provider state', async () => {
	const f = await setup();
	expect(await f.json('draft', 'maya-chen', 'See you at ten')).toMatchObject({
		code: 0,
	});
	expect(await f.subject()).toBe('messages: draft maya-chen');
	expect(await f.changedPaths()).toBe('drafts/maya-chen.md');
	expect(await f.json('read', 'maya-chen')).toMatchObject({
		code: 0,
		answer: { returned: { draft: 'See you at ten' } },
	});
	expect(await f.json('send', 'maya-chen')).toMatchObject({
		code: 0,
		answer: { returned: { outcome: 'sent', send: { state: 'sent' } } },
	});
	expect(await f.subject()).toBe('messages: send maya-chen');
	expect(await f.changedPaths()).toBe(
		'drafts/maya-chen.md\nsends/maya-chen.md',
	);
	expect((await f.state()).messages).toHaveLength(1);
	expect(await gitIn(f.dir, 'status', '--porcelain', '--ignored')).toContain(
		'!! beeper-demo.local.json',
	);
	expect(await gitIn(f.dir, 'log', '--name-only', '--format=')).not.toContain(
		'beeper-demo.local.json',
	);
	expect(await f.json('send', 'maya-chen')).toMatchObject({
		code: 1,
		answer: { threw: { thrown: { name: 'Refused' } } },
	});
	expect((await f.state()).messages).toHaveLength(1);
});

test('CLI unconfirmed send commits its returned outcome and refuses a new send until explicitly resolved', async () => {
	const f = await setup();
	await f.json('draft', 'harbor-ferry', 'Is there room for a bicycle?');
	const sent = await f.json('send', 'harbor-ferry');
	expect(sent).toMatchObject({
		code: 0,
		answer: {
			returned: {
				outcome: 'unconfirmed',
				send: { state: 'unconfirmed', needsCheck: true },
			},
		},
	});
	expect(await f.subject()).toBe('messages: send harbor-ferry');
	expect(await f.changedPaths()).toBe(
		'drafts/harbor-ferry.md\nsends/harbor-ferry.md',
	);
	await f.json('draft', 'harbor-ferry', 'One more question');
	expect(await f.json('send', 'harbor-ferry')).toMatchObject({
		code: 1,
		answer: { threw: { thrown: { name: 'Refused' } } },
	});
	expect(
		(await f.state()).messages.filter((row) => row.chat === 'harbor-ferry'),
	).toHaveLength(1);
	const current = await f.json('read', 'harbor-ferry');
	const attempt = current.answer.returned.send.attempt;
	expect(
		await f.json('resolve', 'harbor-ferry', 'sent', '--attempt', attempt),
	).toMatchObject({
		code: 0,
		answer: { returned: { send: { state: 'sent' } } },
	});
	expect(await f.subject()).toBe('messages: resolve harbor-ferry');
	expect(await f.changedPaths()).toBe('sends/harbor-ferry.md');
	expect((await f.state()).messages).toHaveLength(1);
});

test('two CLI send processes claim one saved draft and reach the provider once', async () => {
	const f = await setup();
	await f.json('draft', 'maya-chen', 'Only once');
	const results = await Promise.all([
		f.run('messages', 'send', 'maya-chen', '--json'),
		f.run('messages', 'send', 'maya-chen', '--json'),
	]);
	expect(results.map((result) => result.code).sort()).toEqual([0, 1]);
	expect(await gitIn(f.dir, 'status', '--porcelain')).toBe('');
	expect((await f.state()).messages).toEqual([
		expect.objectContaining({ chat: 'maya-chen', text: 'Only once' }),
	]);
	expect(await f.json('read', 'maya-chen')).toMatchObject({
		answer: { returned: { draft: '', send: { state: 'sent' } } },
	});
});

test('plain CLI output leads with the unconfirmed outcome and explains the next step', async () => {
	const f = await setup();
	await f.json('draft', 'harbor-ferry', 'Is there room?');
	const result = await f.run('messages', 'send', 'harbor-ferry');
	expect(result.code).toBe(0);
	expect(result.stdout).toContain('outcome: unconfirmed');
	expect(result.stdout).toContain(
		'next: Beeper did not confirm the message to Harbor ferry desk.',
	);
	const current = await f.json('read', 'harbor-ferry');
	expect(result.stdout).toContain(
		`--attempt ${current.answer.returned.send.attempt}`,
	);
	expect(await gitIn(f.dir, 'status', '--porcelain')).toBe('');
});
