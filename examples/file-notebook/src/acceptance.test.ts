import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBrowserFiles } from './browser-files.js';
import { openBrowserShell } from './browser-shell.js';
import { openNativeFiles } from './native-files.js';
import { filesDefinition, notesDefinition, openFileStore } from './views.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const temporary: string[] = [];
afterEach(async () => {
	await Promise.all(
		temporary
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

test('browser app and shell read one current file set and refuse stale replacement', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const assets = openFileStore(filesDefinition, files);
	const photo = `${filesDefinition.id}/files/f1~photo.md`;
	const note = `${notesDefinition.id}/notes/n1~field-visit.md`;
	const image = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 1, 2, 3]);
	await assets.createRow('files', photo, { caption: 'Photo' }, '', {
		path: `${filesDefinition.id}/files/f1~photo.jpg`,
		bytes: image,
	});
	await notes.createRow(
		'notes',
		note,
		{ title: 'Field visit' },
		`![Photo](../../${filesDefinition.id}/files/f1~photo.jpg)`,
	);
	await notes.setKv('weather', 'sunny');
	const before = await files.read(note);
	if (!before) throw new Error('note missing');
	const fromShell = await files.replace(
		before,
		encoder.encode(
			decoder.decode(before.bytes).replace('Field visit', 'Shell visit'),
		),
	);
	const typed = await notes.rows('notes');
	if (!('fields' in typed[0]!)) throw new Error('typed row missing');
	expect(typed[0]?.fields?.title).toBe('Shell visit');
	await notes.setField(fromShell, 'title', 'App visit');
	expect(decoder.decode((await files.read(note))?.bytes)).toContain(
		'App visit',
	);
	await expect(
		files.replace(fromShell, encoder.encode('stale')),
	).rejects.toThrow('Changed since read');
	expect(
		(await files.read(`${filesDefinition.id}/files/f1~photo.jpg`))?.bytes,
	).toEqual(image);
	expect((await notes.kv()).values.weather).toBe('sunny');
});

test('malformed and unfamiliar source remains exact while another row changes', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const bad = `${notesDefinition.id}/notes/n2~bad.md`;
	const unknown = `${notesDefinition.id}/scratch/foreign.bin`;
	const raw = encoder.encode('---\ninvalid: [\n---\nbody\n');
	await files.create(bad, raw);
	await files.create(unknown, Uint8Array.from([0, 255, 11]));
	await notes.createRow(
		'notes',
		`${notesDefinition.id}/notes/n1.md`,
		{ title: 'Good' },
		'body',
	);
	const rows = await notes.rows('notes');
	expect(rows.find((row) => row.path === bad)?.error).toBeDefined();
	expect((await files.read(bad))?.bytes).toEqual(raw);
	expect((await files.read(unknown))?.bytes).toEqual(
		Uint8Array.from([0, 255, 11]),
	);
});

test('native Bash sees real files and app write detects prior external change', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-file-notebook-'));
	temporary.push(root);
	const files = await openNativeFiles(root);
	const note = `${notesDefinition.id}/notes/n1.md`;
	const notes = openFileStore(notesDefinition, files);
	await notes.createRow('notes', note, { title: 'Before' }, 'body');
	const stale = await files.read(note);
	if (!stale) throw new Error('note missing');
	const nativePath = join(root, note);
	await writeFile(
		nativePath,
		decoder.decode(stale.bytes).replace('Before', 'Outside'),
	);
	await expect(notes.setField(stale, 'title', 'App')).rejects.toThrow(
		'Changed since read',
	);
	expect(await readFile(nativePath, 'utf8')).toContain('Outside');
});

test('row publication refuses duplicate IDs and orphan attachment adoption', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-file-notebook-'));
	temporary.push(root);
	for (const files of [
		await openBrowserFiles(crypto.randomUUID()),
		await openNativeFiles(root),
	]) {
		const notes = openFileStore(notesDefinition, files);
		const assets = openFileStore(filesDefinition, files);
		await notes.createRow(
			'notes',
			`${notesDefinition.id}/notes/n1.md`,
			{ title: 'One' },
			'',
		);
		await expect(
			notes.createRow(
				'notes',
				`${notesDefinition.id}/notes/n1~two.md`,
				{ title: 'Two' },
				'',
			),
		).rejects.toThrow();
		await files.create(
			`${filesDefinition.id}/files/f1~photo.png`,
			Uint8Array.of(1),
		);
		await expect(
			assets.createRow(
				'files',
				`${filesDefinition.id}/files/f1~photo.md`,
				{ caption: 'Photo' },
				'',
				{
					path: `${filesDefinition.id}/files/f1~photo.jpg`,
					bytes: Uint8Array.of(2),
				},
			),
		).rejects.toThrow();
		expect(
			await files.read(`${filesDefinition.id}/files/f1~photo.jpg`),
		).toBeUndefined();
	}
});

test('typed file view reports ambiguous attachments without changing either file', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const assets = openFileStore(filesDefinition, files);
	const row = `${filesDefinition.id}/files/f1~photo.md`;
	await assets.createRow('files', row, { caption: 'Photo' }, '', {
		path: `${filesDefinition.id}/files/f1~photo.jpg`,
		bytes: Uint8Array.of(1),
	});
	const competing = `${filesDefinition.id}/files/f1~photo.PNG`;
	await files.create(competing, Uint8Array.of(2));
	expect((await assets.rows('files'))[0]?.error).toContain(
		'multiple same-stem attachments',
	);
	expect((await files.read(competing))?.bytes).toEqual(Uint8Array.of(2));
});

test('KV edit preserves an unknown large integer as source bytes', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const path = `${notesDefinition.id}/kv.json`;
	await files.create(
		path,
		encoder.encode('{"weather":"sun","unknown":9007199254740993}'),
	);
	await notes.setKv('weather', 'rain');
	expect(decoder.decode((await files.read(path))?.bytes)).toBe(
		'{"weather":"rain","unknown":9007199254740993}',
	);
});

test('typed Markdown edit preserves BOM, CRLF, comment, unknown field, and body', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const path = `${notesDefinition.id}/notes/n1.md`;
	const text =
		'\uFEFF---\r\nunknown: 17\r\ntitle: "Old" # keep\r\n---\r\n\r\nBody\r\n';
	const source = await files.create(path, encoder.encode(text));
	await notes.setField(source, 'title', 'New');
	expect((await files.read(path))?.bytes).toEqual(
		encoder.encode(text.replace('"Old"', '"New"')),
	);
});

test('native checked writers serialize and symlink reads have no outside side effects', async () => {
	const root = await mkdtemp(join(tmpdir(), 'epicenter-file-notebook-'));
	const outside = await mkdtemp(join(tmpdir(), 'epicenter-outside-'));
	temporary.push(root, outside);
	const files = await openNativeFiles(root);
	const path = `${notesDefinition.id}/notes/n1.md`;
	const source = await files.create(path, encoder.encode('before'));
	const results = await Promise.allSettled([
		files.replace(source, encoder.encode('first')),
		files.replace(source, encoder.encode('second')),
	]);
	expect(
		results.filter((result) => result.status === 'fulfilled'),
	).toHaveLength(1);
	await symlink(outside, join(root, 'escape'));
	await expect(
		files.read('escape/created-by-read/missing.txt'),
	).rejects.toThrow();
	await expect(
		readFile(join(outside, 'created-by-read/missing.txt')),
	).rejects.toThrow();
	await expect(files.snapshot()).rejects.toThrow('symlink');
});

test('just-bash reads and edits the browser account files used by the typed view', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const path = `${notesDefinition.id}/notes/n1.md`;
	await notes.createRow('notes', path, { title: 'Before' }, 'Body');
	const shell = openBrowserShell(files);
	expect((await shell.exec(`cat ${path}`)).stdout).toContain('Before');
	const result = await shell.exec(`sed -i 's/Before/After/' ${path}`);
	expect(result.exitCode).toBe(0);
	const row = (await notes.rows('notes'))[0];
	expect(row && 'fields' in row && row.fields?.title).toBe('After');
});

test('just-bash refuses a replacement after an intervening app save', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const path = `${notesDefinition.id}/notes/n1.md`;
	await notes.createRow('notes', path, { title: 'Before' }, 'Body');
	let intervened = false;
	const shell = openBrowserShell({
		...files,
		async replace(source, bytes) {
			if (!intervened) {
				intervened = true;
				const current = await files.read(path);
				if (!current) throw new Error('note missing');
				await notes.setField(current, 'title', 'App');
			}
			return files.replace(source, bytes);
		},
	});
	const result = await shell.exec(`sed -i 's/Before/Shell/' ${path}`);
	expect(intervened).toBe(true);
	expect(result.exitCode).not.toBe(0);
	expect(decoder.decode((await files.read(path))?.bytes)).toContain('App');
});

test('overlapping shell commands preserve their read and write order', async () => {
	const files = await openBrowserFiles(crypto.randomUUID());
	const notes = openFileStore(notesDefinition, files);
	const path = `${notesDefinition.id}/notes/n1.md`;
	await notes.createRow('notes', path, { title: 'Before' }, 'Body');
	const shell = openBrowserShell(files, 'trip-archive');
	expect((await shell.exec('pwd')).stdout.trim()).toBe(
		'/Epicenter/accounts/trip-archive',
	);
	const [first, second] = await Promise.all([
		shell.exec(`sed -i 's/Before/One/' ${path}`),
		shell.exec(`sed -i 's/One/Two/' ${path}`),
	]);
	expect(first.exitCode).toBe(0);
	expect(second.exitCode).toBe(0);
	expect((await notes.rows('notes'))[0]?.fields?.title).toBe('Two');
});
