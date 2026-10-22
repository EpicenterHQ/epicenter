/**
 * `epicenter whispering-connection read|set`, through fresh CLI processes
 * over a real Epicenter folder in a new temporary directory, named by
 * `EPICENTER_FOLDER_DIR` as the desktop shell names it.
 *
 * Key behaviors:
 * - The operation names one of two fixed rows of `so.epicenter`; no path is
 *   taken, and input beyond the closed field assignments is refused.
 * - Updating the current row preserves source details: a byte-order mark, CRLF
 *   line endings, comments, unknown fields, and the body survive a save
 *   that changes one field.
 * - A row whose frontmatter does not parse is answered with its issues, and
 *   a save of it is refused with its bytes untouched.
 * - Reading creates nothing; a save creates `so.epicenter` only inside an
 *   Epicenter folder that is there, and a link or file there is refused.
 *
 * They run `src/bin.ts` under Bun, or the binary `EPICENTER_BIN` names.
 */
import { afterEach, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import {
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	symlink,
	writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { connectionsTables } from '@epicenter/ai/connection-table';
import { openFolder } from '@epicenter/folder/bun';
import { expectOk } from 'wellcrafted/testing';

const binary = process.env.EPICENTER_BIN;
const command = binary
	? [resolve(binary)]
	: [process.execPath, '--no-install', resolve(import.meta.dir, 'bin.ts')];
const temporary: string[] = [];

afterEach(async () => {
	await Promise.all(
		temporary.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
	);
});

/** A new Epicenter folder, `<scratch>/Epicenter`, and the CLI run over it. */
async function setup({ folderDir = true } = {}) {
	const scratch = await mkdtemp(join(tmpdir(), 'epicenter-connection-rows-'));
	temporary.push(scratch);
	const epicenter = join(scratch, 'Epicenter');
	if (folderDir) await mkdir(epicenter);
	const settings = join(epicenter, 'so.epicenter');
	const rowFile = (id = 'whispering-text') =>
		join(settings, 'connections', `${id}.md`);

	async function run(args: string[], stdin?: unknown) {
		const child = Bun.spawn(
			[...command, 'whispering-connection', ...args, '--json'],
			{
				env: {
					PATH: process.env.PATH,
					EPICENTER_FOLDER_DIR: epicenter,
					EPICENTER_DATA_DIR: join(scratch, 'data'),
					EPICENTER_API_URL: 'http://127.0.0.1:9',
				},
				stdin:
					stdin === undefined
						? 'ignore'
						: new TextEncoder().encode(
								typeof stdin === 'string' ? stdin : JSON.stringify(stdin),
							),
				stdout: 'pipe',
				stderr: 'pipe',
			},
		);
		const [code, out, err] = await Promise.all([
			child.exited,
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const lines = out.trim().split('\n');
		return { code, reply: JSON.parse(lines.at(-1) as string), lines, err };
	}

	async function write(text: string | Uint8Array, id?: string) {
		await mkdir(join(settings, 'connections'), { recursive: true });
		await writeFile(rowFile(id), text);
	}

	return { scratch, epicenter, settings, rowFile, run, write };
}

test('reading a row that is not there answers none and creates nothing', async () => {
	const { epicenter, run } = await setup();
	expect(await run(['read', 'text'])).toMatchObject({
		code: 0,
		reply: { row: null },
		lines: ['{"row":null}'],
	});
	expect(await readdir(epicenter)).toEqual([]);

	const gone = await setup({ folderDir: false });
	expect((await gone.run(['read', 'transcription'])).reply).toEqual({
		row: null,
	});
	expect(existsSync(gone.epicenter)).toBe(false);
});

test('a save makes the row with the assigned fields and no endpoint or key, and reads back as sent', async () => {
	const { run, rowFile, epicenter } = await setup();
	const saved = await run(['set', 'transcription'], {
		fields: {
			kind: 'openai-compatible',
			title: 'Whispering transcription',
			model: 'whisper-1',
		},
	});
	expect(saved.code).toBe(0);
	const text = await readFile(rowFile('whispering-transcription'), 'utf8');
	expect(text).toBe(
		'---\nkind: openai-compatible\nmodel: whisper-1\ntitle: Whispering transcription\n---\n',
	);
	expect(saved.reply).toEqual({
		row: {
			text,
			issues: null,
			fields: {
				kind: 'openai-compatible',
				title: 'Whispering transcription',
				model: 'whisper-1',
			},
		},
	});
	expect((await run(['read', 'transcription'])).reply).toEqual(saved.reply);
	// Only the one row lives inside the records directory.
	expect(await readdir(join(epicenter, 'so.epicenter'))).toEqual([
		'connections',
	]);
	expect(await readdir(join(epicenter, 'so.epicenter', 'connections'))).toEqual(
		['whispering-transcription.md'],
	);
});

test('a row read and saved through JSON keeps its byte-order mark, line endings, comments, unknown fields, and body', async () => {
	const { run, write, rowFile } = await setup();
	const source =
		'﻿---\r\n# Set up in Settings\r\nkind: openai-compatible # the kind\r\ntitle: Whispering text\r\nmodel: old-model\r\nretries: 3\r\nextra:\r\n  nested: two\r\n---\r\nNotes about this endpoint.\r\n';
	await write(source);

	const { reply: read } = await run(['read', 'text']);
	expect(read.row.text).toBe(source);
	expect(read.row.issues).toBeNull();
	expect(read.row.fields).toEqual({
		kind: 'openai-compatible',
		title: 'Whispering text',
		model: 'old-model',
	});

	const saved = await run(['set', 'text'], {
		fields: { kind: 'openai-compatible', model: 'new-model' },
	});
	expect(saved.code).toBe(0);
	const expected = source.replace('model: old-model', 'model: new-model');
	expect(await readFile(rowFile(), 'utf8')).toBe(expected);
	expect(saved.reply.row.text).toBe(expected);
});

test('field assignments use the current source after a Settings publication', async () => {
	const { run, write, rowFile, settings } = await setup();
	await write(
		'---\nkind: openai-compatible\ntitle: Whispering text\nmodel: old-model\n---\n',
	);
	const { reply: read } = await run(['read', 'text']);
	expect(read.row.fields.model).toBe('old-model');

	// Settings opens the folder as its own and saves a title and a new field.
	const folder = expectOk(
		await openFolder({ directory: settings, tables: connectionsTables }),
	);
	expectOk(
		await folder.tables.connections.set('whispering-text', {
			fields: { title: 'Renamed in Settings', note: 'from Settings' },
		}),
	);
	await folder.close();

	const saved = await run(['set', 'text'], {
		fields: { kind: 'openai-compatible', model: 'new-model' },
	});
	expect(saved.code).toBe(0);
	const text = await readFile(rowFile(), 'utf8');
	expect(text).toContain('title: Renamed in Settings');
	expect(text).toContain('note: from Settings');
	expect(text).toContain('model: new-model');
	expect(text).not.toContain('old-model');
});

test('a row whose frontmatter does not parse is answered with its issues, and a save of it changes no byte', async () => {
	const { run, write, rowFile } = await setup();
	const broken = '---\nkind: [open\nmodel: m\n---\nbody\n';
	await write(broken);

	const { code, reply: read } = await run(['read', 'text']);
	expect(code).toBe(0);
	expect(read.row.text).toBe(broken);
	expect(read.row.fields).toBeNull();
	expect(read.row.issues).toHaveLength(1);
	expect(read.row.issues[0].kind).toBe('frontmatter');

	{
		const refused = await run(['set', 'text'], {
			fields: { kind: 'openai-compatible', model: 'new-model' },
		});
		expect(refused.code).toBe(2);
		expect(refused.reply.name).toBe('SaveFailed');
		expect(refused.reply.error).toContain(
			'so.epicenter/connections/whispering-text.md was not changed',
		);
		expect(await readFile(rowFile(), 'utf8')).toBe(broken);
	}
});

test('only the two operations and the closed field assignments are taken, and a refusal writes nothing', async () => {
	const { run, epicenter } = await setup();
	for (const operation of [
		'whispering-text',
		'../so.epicenter/connections/x',
		'constructor',
		'other',
	]) {
		for (const action of ['read', 'set']) {
			const refused = await run([action, operation], {
				fields: { model: 'm' },
			});
			expect(refused.code).toBe(2);
			expect(refused.reply.name).toBe('InvalidInput');
		}
	}
	for (const input of [
		'not json',
		{ base: null, fields: { model: 'm' } },
		{ fields: { kind: 'epicenter', model: 'm' } },
		{ fields: { kind: 'local', model: 'm' } },
		{ fields: { model: 'm', body: 'text' } },
		{ fields: { model: 'm', endpoint: 'https://x.test/v1' } },
		{ fields: { model: 3 } },
		{ fields: {}, path: '/tmp/x.md' },
		{ base: { text: 'a' }, fields: { model: 'm' } },
	]) {
		const refused = await run(['set', 'text'], input);
		expect(refused.code).toBe(2);
		expect(refused.reply.name).toBe('InvalidInput');
	}
	expect(await readdir(epicenter)).toEqual([]);
});

test('a save makes so.epicenter inside the Epicenter folder, never the Epicenter folder itself', async () => {
	const { run, rowFile } = await setup();
	const save = { fields: { model: 'm' } };
	expect((await run(['set', 'text'], save)).code).toBe(0);
	expect(await readFile(rowFile(), 'utf8')).toBe('---\nmodel: m\n---\n');

	const firstUse = await setup({ folderDir: false });
	expect((await firstUse.run(['set', 'text'], save)).code).toBe(0);
	expect(await readFile(firstUse.rowFile(), 'utf8')).toBe(
		'---\nmodel: m\n---\n',
	);
});

test('a connection save cannot select records inside an existing app home', async () => {
	const { scratch, epicenter, settings, run } = await setup();
	const data = join(scratch, 'data');
	await mkdir(data);
	const config = join(data, 'folders.json');
	const original = JSON.stringify({ homes: { todos: epicenter }, folders: [] });
	await writeFile(config, original);
	const result = await run(['set', 'text'], { fields: { model: 'm' } });
	expect(result.code).toBe(2);
	expect(result.reply.name).toBe('FolderUnusable');
	expect(result.reply.error).toContain('cannot overlap the todos home');
	expect(await readFile(config, 'utf8')).toBe(original);
	expect(existsSync(settings)).toBe(false);
});

test('a link or a file at so.epicenter is refused, and nothing is read or written through it', async () => {
	const linked = await setup();
	const elsewhere = join(linked.scratch, 'elsewhere');
	await mkdir(join(elsewhere, 'connections'), { recursive: true });
	await writeFile(
		join(elsewhere, 'connections', 'whispering-text.md'),
		'---\nmodel: elsewhere\n---\n',
	);
	await symlink(elsewhere, linked.settings);
	for (const [action, input] of [
		['read', undefined],
		['set', { fields: { model: 'm' } }],
	] as const) {
		const refused = await linked.run([action, 'text'], input);
		expect(refused.code).toBe(2);
		expect(refused.reply.name).toBe('FolderUnusable');
		expect(refused.reply.error).toContain('is a link or not a directory');
	}
	expect(
		await readFile(
			join(elsewhere, 'connections', 'whispering-text.md'),
			'utf8',
		),
	).toBe('---\nmodel: elsewhere\n---\n');

	const file = await setup();
	await writeFile(file.settings, 'not a folder');
	const refused = await file.run(['set', 'text'], {
		fields: { model: 'm' },
	});
	expect(refused.reply.name).toBe('FolderUnusable');
	expect(await readFile(file.settings, 'utf8')).toBe('not a folder');
});
