/**
 * The folder on disk preserves relative paths and atomic writes.
 * Listing excludes dependency and Git directories and never traverses directory links.
 * `update` changes what is there when it writes, never what was there when it read,
 * and concurrent updates in one process, through it or a collection's `update`,
 * each land. Across processes a call's lock keeps writers apart (`layout.test.ts`).
 */
import { afterEach, expect, test } from 'bun:test';
import { writeFileSync } from 'node:fs';
import {
	chmod,
	mkdir,
	mkdtemp,
	readdir,
	rm,
	stat,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
	ActionError,
	createMemoryContext,
	defineCollection,
	field,
	inRun,
	Ok,
} from '@epicenter/app';
import { folderOnDisk } from './disk.ts';
import { gitIn } from './runner.test-support.ts';

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(
		roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});
/** A repository to write in, and its folder. */
async function setup() {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-disk-'));
	roots.push(root);
	await gitIn(root, 'init', '-q');
	return { root, folder: folderOnDisk(root) };
}

test('writes make parents, replace whole files and leave no temporary files', async () => {
	const { root, folder } = await setup();
	await folder.write('nested/a.txt', 'first');
	await folder.write('nested/a.txt', 'second');
	expect(await folder.read('nested/a.txt')).toBe('second');
	expect(await readdir(join(root, 'nested'))).toEqual(['a.txt']);
	await folder.writeBytes('bytes', new Uint8Array([0, 255]));
	expect(await folder.readBytes('bytes')).toEqual(Buffer.from([0, 255]));
	expect(await folder.read('missing')).toBeUndefined();
	await folder.delete('missing');
	await folder.delete('bytes');
	expect(await folder.readBytes('bytes')).toBeUndefined();
});

test('a write keeps the mode of the file it replaces', async () => {
	const { root, folder } = await setup();
	await folder.write('run.sh', 'echo one\n');
	await chmod(join(root, 'run.sh'), 0o755);
	await folder.write('run.sh', 'echo two\n');
	expect((await stat(join(root, 'run.sh'))).mode & 0o777).toBe(0o755);
	expect(await folder.read('run.sh')).toBe('echo two\n');
});

test('a new .local file is readable by its owner alone, made by write or update', async () => {
	const { root, folder } = await setup();
	const mode = async (path: string) =>
		(await stat(join(root, path))).mode & 0o777;
	await folder.write('google.local.md', '---\nrefreshToken: "a"\n---\n');
	await folder.update('tokens.local/mail.md', () => 'b');
	await folder.write('notes.md', 'shared');
	expect(await mode('google.local.md')).toBe(0o600);
	expect(await mode('tokens.local/mail.md')).toBe(0o600);
	expect(await mode('notes.md')).not.toBe(0o600);
	// A .local file whose owner widened it keeps what they chose.
	await chmod(join(root, 'google.local.md'), 0o640);
	await folder.write('google.local.md', 'again');
	expect(await mode('google.local.md')).toBe(0o640);
});

test('a new directory on a .local path is open to its owner alone, and one there already keeps its mode', async () => {
	const { root, folder } = await setup();
	const mode = async (path: string) =>
		(await stat(join(root, path))).mode & 0o777;
	await folder.write('accounts/keys.local/mail/token.md', 'a');
	expect(await mode('accounts')).toBe(0o755);
	expect(await mode('accounts/keys.local')).toBe(0o700);
	expect(await mode('accounts/keys.local/mail')).toBe(0o700);
	await mkdir(join(root, 'shared.local'), { mode: 0o755 });
	await folder.update('shared.local/token.md', () => 'b');
	expect(await mode('shared.local')).toBe(0o755);
	await folder.write('notes/today.md', 'c');
	expect(await mode('notes')).toBe(0o755);
});

test('normalization refuses climbing, absolute and Git paths on every file method', async () => {
	const { folder } = await setup();
	for (const path of ['../x', '/abs', '.git/config']) {
		await expect(folder.read(path)).rejects.toThrow();
		await expect(folder.readBytes(path)).rejects.toThrow();
		await expect(folder.write(path, 'no')).rejects.toThrow();
		await expect(folder.writeBytes(path, new Uint8Array())).rejects.toThrow();
		await expect(folder.update(path, () => 'no')).rejects.toThrow();
		await expect(folder.delete(path)).rejects.toThrow();
		await expect(folder.list(path)).rejects.toThrow();
	}
});

test('listing is sorted and folder-relative and skips dependency trees and directory links', async () => {
	const { root, folder } = await setup();
	for (const file of [
		'z',
		'nested/b',
		'nested/a',
		'nested/.git/config',
		'nested/node_modules/pkg/file',
	]) {
		await mkdir(dirname(join(root, file)), { recursive: true });
		await writeFile(join(root, file), 'data');
	}
	await symlink(join(root, 'nested'), join(root, 'directory-link'));
	await symlink(join(root, 'z'), join(root, 'file-link'));
	expect(await folder.list()).toEqual([
		'file-link',
		'nested/a',
		'nested/b',
		'z',
	]);
	expect(await folder.list('nested')).toEqual(['nested/a', 'nested/b']);
	expect(await folder.list('missing')).toEqual([]);
	expect(await folder.list('directory-link')).toEqual([]);
	expect(await folder.list('nested/node_modules')).toEqual([]);
});

test('update changes a file that starts with a byte order mark, comparing what is there as bytes', async () => {
	const { root, folder } = await setup();
	await writeFile(join(root, 'bom.txt'), '﻿a\n');
	expect(await folder.update('bom.txt', (text) => `${text}b\n`)).toBe('a\nb\n');
	expect(await folder.read('bom.txt')).toBe('a\nb\n');
});

test('concurrent updates of one file each land, and leave nothing beside it', async () => {
	const { root, folder } = await setup();
	await folder.write('log.txt', '');
	await Promise.all(
		Array.from({ length: 8 }, (_, n) =>
			folder.update('log.txt', (text = '') => `${text}${n}\n`),
		),
	);
	const lines = (await folder.read('log.txt'))?.trimEnd().split('\n');
	expect(lines?.sort()).toEqual(['0', '1', '2', '3', '4', '5', '6', '7']);
	expect((await readdir(root)).sort()).toEqual(['.git', 'log.txt']);
});

test('concurrent updates of one collection file each land, each computed from the record it replaces', async () => {
	const { root, folder } = await setup();
	const counters = defineCollection({
		path: 'data/counters/{id}.md',
		fields: { n: field.integer({ optional: true }) },
	});
	await folder.write('data/counters/a.md', '---\nn: 0\n---\n');
	const context = { folder };
	const at = { id: 'a' };
	await Promise.all(
		Array.from({ length: 5 }, () =>
			inRun(context, () =>
				counters.update(at, (record) => Ok({ n: (record?.n ?? 0) + 1 })),
			),
		),
	);
	expect(await folder.read('data/counters/a.md')).toBe('---\nn: 5\n---\n');
	expect((await readdir(join(root, 'data/counters'))).sort()).toEqual(['a.md']);
});

test('an update that changes nothing leaves the file untouched', async () => {
	const { root, folder } = await setup();
	await folder.write('same.txt', 'a\n');
	const before = await stat(join(root, 'same.txt'));
	expect(await folder.update('same.txt', (text) => text ?? '')).toBe('a\n');
	const after = await stat(join(root, 'same.txt'));
	expect([after.ino, after.mtimeMs]).toEqual([before.ino, before.mtimeMs]);
});

test('update runs its change once and does not look at the file again', async () => {
	const { root, folder } = await setup();
	await folder.write('once.txt', '0');
	let runs = 0;
	const written = await folder.update('once.txt', () => {
		runs++;
		// A writer outside epicenter is not guarded against: the update wins.
		writeFileSync(join(root, 'once.txt'), 'outside');
		return 'mine';
	});
	expect([runs, written]).toEqual([1, 'mine']);
	expect(await folder.read('once.txt')).toBe('mine');
	expect((await readdir(root)).sort()).toEqual(['.git', 'once.txt']);
});

test('update whose change throws writes nothing', async () => {
	const { root, folder } = await setup();
	await folder.write('kept.txt', 'kept');
	await expect(
		folder.update('kept.txt', () => {
			throw new Error('no change');
		}),
	).rejects.toThrow('no change');
	await expect(
		folder.update('absent.txt', () => {
			throw new Error('no file');
		}),
	).rejects.toThrow('no file');
	expect(await folder.read('kept.txt')).toBe('kept');
	expect((await readdir(root)).sort()).toEqual(['.git', 'kept.txt']);
});

test('a collection forwards returned Changed and lets a thrown Changed escape, including on an absent file', async () => {
	const disk = await setup();
	for (const folder of [disk.folder, createMemoryContext().folder]) {
		const path = 'data/counter.md';
		const counter = defineCollection({
			path,
			fields: { n: field.integer({ optional: true }) },
		});
		const refusal = ActionError.Changed({ path, why: 'was' });
		expect(await inRun({ folder }, () => counter.update(() => refusal))).toBe(
			refusal,
		);
		const thrown = await inRun({ folder }, () =>
			counter.update(() => {
				throw refusal.error;
			}),
		).catch((cause: unknown) => cause);
		expect(thrown).toBe(refusal.error);
		expect(await folder.read(path)).toBeUndefined();
		const answer = await inRun({ folder }, () =>
			counter.update((record) => {
				record.n = 1;
				return Ok({});
			}),
		);
		expect(answer).toEqual(Ok({ path, body: '' }));
		expect(await folder.read(path)).toBeUndefined();
	}
});

test('a local record omits partial values and body from every repair refusal', async () => {
	const { folder } = await setup();
	const path = 'data/accounts.local.md';
	const accounts = defineCollection({
		path,
		fields: {
			token: field.text({ optional: true }),
			unit: field.integer({ optional: true }),
		},
	});
	const stored =
		'---\ntoken: "secret-token"\nunit: "secret-invalid"\n---\nsecret-body';
	await folder.write(path, stored);
	await inRun({ folder }, async () => {
		for (const result of [
			await accounts.get(),
			await accounts.set({ token: 'new-secret' }),
			await accounts.update(() => {
				throw new Error('misfit reached callback');
			}),
		]) {
			expect(result.error?.name).toBe('Misfit');
			expect(result.error).not.toHaveProperty('record');
			expect(JSON.stringify(result)).not.toContain('secret');
		}
	});
	expect(await folder.read(path)).toBe(stored);
});

test('collection edits through a read-only run decide only on local paths', async () => {
	const context = { ...createMemoryContext(), readOnly: { action: 'list' } };
	const publicRecord = defineCollection({ path: 'data/public.md', fields: {} });
	const cache = defineCollection({ path: 'data/cache.local.md', fields: {} });
	let decisions = 0;
	const decide = () => {
		decisions++;
		return Ok({ body: 'seen' });
	};
	await inRun(context, async () => {
		await expect(publicRecord.update(decide)).rejects.toThrow('read-only');
		expect(decisions).toBe(0);
		expect((await cache.update(decide)).data?.body).toBe('seen');
	});
	expect(decisions).toBe(1);
});
