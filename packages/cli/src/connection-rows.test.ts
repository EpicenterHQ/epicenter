/**
 * `epicenter whispering-connection read|set`, through fresh CLI processes
 * over a real Epicenter folder in a new temporary directory, named by
 * `EPICENTER_FOLDER_DIR` as the desktop shell names it.
 *
 * Key behaviors:
 * - The operation names one of two fixed rows of `so.epicenter`; no path is
 *   taken, and input beyond the closed field assignments is refused.
 * - Reads answer exact source; updates keep unknown fields and body while
 *   writing canonical frontmatter.
 * - A row whose frontmatter does not parse is answered with its issues, and
 *   a save of it is refused with its bytes untouched.
 * - Reading creates nothing; a save creates the fixed `so.epicenter` when it
 *   is missing, reads and writes no configuration, and a link or file there
 *   is refused.
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
		// SAFETY: every CLI reply ends with one JSON line, including errors.
		return { code, reply: JSON.parse(lines.at(-1) as string), lines, err };
	}

	async function write(text: string | Uint8Array, id?: string) {
		await mkdir(join(settings, 'connections'), { recursive: true });
		await writeFile(rowFile(id), text);
	}

	return { scratch, epicenter, settings, rowFile, run, write };
}

async function runWithFolderMock(
	location: Awaited<ReturnType<typeof setup>>,
	factory: string,
	action: 'read' | 'set',
	input?: unknown,
) {
	const folderModule = Bun.resolveSync(
		'@epicenter/folder/bun',
		import.meta.dir,
	);
	const script = join(location.scratch, 'mock-folder.mjs');
	await writeFile(
		script,
		`import { mock } from 'bun:test';
mock.module(${JSON.stringify(folderModule)}, ${factory});
await import(${JSON.stringify(resolve(import.meta.dir, 'bin.ts'))});
`,
	);
	const child = Bun.spawn(
		[
			process.execPath,
			'--no-install',
			script,
			'whispering-connection',
			action,
			'text',
			'--json',
		],
		{
			env: {
				PATH: process.env.PATH,
				EPICENTER_FOLDER_DIR: location.epicenter,
				EPICENTER_DATA_DIR: join(location.scratch, 'data'),
			},
			stdin:
				input === undefined
					? 'ignore'
					: new TextEncoder().encode(JSON.stringify(input)),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [code, out, err] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	if (out.trim() === '') throw new Error(err);
	return { code, reply: JSON.parse(out), err };
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
		'---\nkind: openai-compatible\ntitle: Whispering transcription\nmodel: whisper-1\n---\n',
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

test('a read keeps exact source and a save writes canonical frontmatter with unknown fields and body', async () => {
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
	const expected =
		'---\nkind: openai-compatible\ntitle: Whispering text\nmodel: new-model\nextra:\n  nested: two\nretries: 3\n---\nNotes about this endpoint.\r\n';
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
		await folder.write(
			'connections/whispering-text.md',
			'---\nkind: openai-compatible\ntitle: Renamed in Settings\nmodel: old-model\nnote: from Settings\n---\n',
		),
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
			'so.epicenter/connections/whispering-text.md could not be saved',
		);
		expect(await readFile(rowFile(), 'utf8')).toBe(broken);
	}
});

test('a missing row saves assigned fields and reads with issues until completed', async () => {
	const { run, rowFile } = await setup();
	const saved = await run(['set', 'text'], { fields: { model: 'm' } });
	expect(saved.code).toBe(0);
	const text = '---\nmodel: m\n---\n';
	expect(await readFile(rowFile(), 'utf8')).toBe(text);
	expect(saved.reply.row.text).toBe(text);
	expect(saved.reply.row.fields).toBeNull();
	expect(saved.reply.row.issues[0].kind).toBe('schema');
	expect((await run(['read', 'text'])).reply).toEqual(saved.reply);
	const repaired = await run(['set', 'text'], {
		fields: { kind: 'openai-compatible', title: 'Text' },
	});
	expect(repaired.code).toBe(0);
	expect(repaired.reply.row.issues).toBeNull();
	expect(repaired.reply.row.fields).toEqual({
		kind: 'openai-compatible',
		title: 'Text',
		model: 'm',
	});
});

test('an unreadable row answers ReadFailed before a save attempts a write', async () => {
	const location = await setup();
	await mkdir(location.settings);
	const factory = `() => ({
	openFolder: async () => ({
		error: null,
		data: {
			tables: { connections: { row: () => ({
				id: 'whispering-text',
				path: 'connections/whispering-text.md',
				fields: undefined,
				body: undefined,
				issues: [{ kind: 'unreadable', message: 'read denied', path: [] }],
			}) } },
			file: () => { throw new Error('unreadable source was decoded'); },
			close: async () => {},
		},
	}),
})`;
	for (const action of ['read', 'set'] as const) {
		const result = await runWithFolderMock(location, factory, action, {
			fields: { model: 'new-model' },
		});
		expect(result.code).toBe(2);
		expect(result.reply.name).toBe('ReadFailed');
	}
});

test('a create that finds a Settings row retries once as an update', async () => {
	const location = await setup();
	const result = await runWithFolderMock(
		location,
		`() => {
		let created = false;
		let updated = false;
		return {
			openFolder: async () => ({
				error: null,
				data: {
					tables: { connections: {
						row: () => created ? {
							id: 'whispering-text', path: 'connections/whispering-text.md',
							fields: { kind: 'openai-compatible', title: 'From Settings', model: updated ? 'new-model' : 'old-model' },
							issues: null, body: '',
						} : undefined,
						create: async () => { created = true; return { error: { name: 'Exists', message: 'already exists' } }; },
						update: async () => { updated = true; return { error: null }; },
					} },
					file: () => ({ data: '---\\nkind: openai-compatible\\ntitle: From Settings\\nmodel: new-model\\nnote: keep\\n---\\n' }),
					close: async () => {},
				},
			}),
		};
	}`,
		'set',
		{
			fields: {
				kind: 'openai-compatible',
				title: 'Initial title',
				model: 'new-model',
			},
		},
	);
	expect(result.code).toBe(0);
	expect(result.reply.row.fields).toEqual({
		kind: 'openai-compatible',
		title: 'From Settings',
		model: 'new-model',
	});
	expect(result.reply.row.text).toContain('note: keep');
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

test('a save creates the fixed records folder and its missing root', async () => {
	const { run, rowFile } = await setup();
	const save = {
		fields: { kind: 'openai-compatible', title: 'Text', model: 'm' },
	};
	expect((await run(['set', 'text'], save)).code).toBe(0);
	expect(await readFile(rowFile(), 'utf8')).toBe(
		'---\nkind: openai-compatible\ntitle: Text\nmodel: m\n---\n',
	);

	const firstUse = await setup({ folderDir: false });
	expect((await firstUse.run(['set', 'text'], save)).code).toBe(0);
	expect(await readFile(firstUse.rowFile(), 'utf8')).toBe(
		'---\nkind: openai-compatible\ntitle: Text\nmodel: m\n---\n',
	);
});

test('a connection save uses the fixed records folder, reading and writing no configuration', async () => {
	const { scratch, epicenter, rowFile, run } = await setup();
	const data = join(scratch, 'data');
	await mkdir(data);
	const config = join(data, 'folders.json');
	const original = JSON.stringify({
		homes: { todos: epicenter, epicenter: join(scratch, 'Old records') },
		folders: [],
	});
	await writeFile(config, original);
	const result = await run(['set', 'text'], {
		fields: { kind: 'openai-compatible', title: 'Text', model: 'm' },
	});
	expect(result.code).toBe(0);
	expect(await readFile(rowFile(), 'utf8')).toBe(
		'---\nkind: openai-compatible\ntitle: Text\nmodel: m\n---\n',
	);
	expect(existsSync(join(scratch, 'Old records'))).toBe(false);
	expect(await readFile(config, 'utf8')).toBe(original);
	expect(await readdir(data)).toEqual(['folders.json']);
});

test('a connection save refuses a records folder inside application data', async () => {
	const { scratch } = await setup();
	const epicenter = join(scratch, 'data', 'Epicenter');
	await mkdir(epicenter, { recursive: true });
	const child = Bun.spawn(
		[...command, 'whispering-connection', 'set', 'text', '--json'],
		{
			env: {
				PATH: process.env.PATH,
				EPICENTER_FOLDER_DIR: epicenter,
				EPICENTER_DATA_DIR: join(scratch, 'data'),
				EPICENTER_API_URL: 'http://127.0.0.1:9',
			},
			stdin: new TextEncoder().encode(
				JSON.stringify({ fields: { model: 'm' } }),
			),
			stdout: 'pipe',
			stderr: 'pipe',
		},
	);
	const [code, out] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
	]);
	expect(code).toBe(2);
	expect(JSON.parse(out).name).toBe('FolderUnusable');
	expect(existsSync(join(epicenter, 'so.epicenter'))).toBe(false);
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
