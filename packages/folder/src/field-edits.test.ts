/**
 * Field Patch, Text Transition and Fence Tests
 *
 * Drives `folder.files.edit(path)` on any Markdown path of a real browser
 * folder (in-memory IndexedDB), with a second handle as another writer. The
 * engine's `write` is replaced below the handle to hold or refuse saves.
 *
 * Key behaviors:
 * - A field patch saves over the file as stored then, keeping removal apart
 *   from `null`, a byte-order mark and CRLF line ends; a failed patch saves
 *   again only on `retry` or new input
 * - Text typed over a field patch while it saves keeps the source the person
 *   saw and takes in the landed fields, so a later revert of them saves and
 *   a body the person never saw survives
 * - Fields typed while text saves go into the text, from the right base
 * - `exclusive` fences its path at once, sends held input first, refuses when
 *   it does not save, releases after a failure, and settle waits for it
 */
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRepository } from './browser/repository.js';
import { openFolder } from './browser.js';
import { BUSY, type ExclusiveFile, UNSAVED } from './edits.js';
import type { FileContent } from './folder.js';
import type { FolderEngine } from './handle.js';
import { folderHandle } from './handle.js';
import { readDocument } from './shared/document.js';
import { SaveError } from './shared/errors.js';
import { fileBytes } from './shared/observation.js';

const encode = (text: string) => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array) =>
	new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

type Write = { path: string; from: FileContent | null; content: FileContent };

/** A fresh profile, its folder with writes the test can hold or refuse, and another writer. */
async function setup(files: Record<string, string> = {}) {
	globalThis.indexedDB = new FakeIndexedDB() as unknown as IDBFactory;
	const repository = await openRepository('default', {});
	const engine = {
		files: { ...repository.files },
		tables: {},
		subscribe: repository.onChange,
		close: repository.close,
	} satisfies FolderEngine;
	const folder = folderHandle(engine, {}, { saveAfterMs: 60_000 });
	cleanup.push(() => folder.close());
	const other = expectOk(await openFolder({ tables: {} }));
	cleanup.push(() => other.close());
	for (const [path, content] of Object.entries(files))
		expectOk(await other.files.write(path, null, content));

	const write = engine.files.write;
	const writes: Write[] = [];
	let gate: PromiseWithResolvers<void> | undefined;
	let started = Promise.withResolvers<void>();
	/** Whether each write is refused as a full disk. */
	let refusing = false;
	engine.files.write = async (path, from, content) => {
		writes.push({ path, from, content });
		started.resolve();
		if (gate !== undefined) await gate.promise;
		if (refusing)
			return SaveError.StorageFailed({ cause: new Error('disk full') });
		return write(path, from, content);
	};
	cleanup.push(() => gate?.resolve());

	return {
		folder,
		other,
		writes,
		/** Hold writes; resolves once the next one starts. */
		hold() {
			gate = Promise.withResolvers();
			started = Promise.withResolvers();
			return started.promise;
		},
		release() {
			const held = gate;
			gate = undefined;
			held?.resolve();
		},
		refuse(refuse: boolean) {
			refusing = refuse;
		},
		/** A file's bytes as a view observes them now. */
		async observe(path: string) {
			const file = expectOk(await folder.files.read(path));
			if (file === undefined) throw new Error(`${path} is not stored`);
			return fileBytes(file.content);
		},
		/** What is stored at `path`, read by the other writer. */
		async stored(path: string) {
			const file = expectOk(await other.files.read(path));
			if (file === undefined) return undefined;
			return decode(await fileBytes(file.content));
		},
	};
}

const before = '---\ntitle: before\nlink: before\n---\nbody before\n';
const external = before.replace('body before', 'body from another writer');
const aliased =
	'---\ntitle: &a before\nlink: *a\n---\nbody from another writer\n';

test('a field change without a source refuses without changing the missing-source snapshot', async () => {
	const { folder } = await setup();
	const edit = folder.files.edit('missing.md');
	const shown = edit.shown(undefined);
	expect(
		expectErr(edit.changeFields(undefined, { title: 'No source' })).name,
	).toBe('NoSource');
	expect(edit.shown(undefined)).toBe(shown);
	expect(edit.pending).toBeUndefined();
	expect(folder.status.unsaved).toEqual([]);
});

for (const { revert, refuseFirst, aliases } of [
	{ revert: false, refuseFirst: false, aliases: false },
	{ revert: true, refuseFirst: false, aliases: false },
	{ revert: false, refuseFirst: true, aliases: false },
	{ revert: false, refuseFirst: false, aliases: true },
]) {
	test(`text typed over a field patch while it saves keeps an outside body (revert: ${revert}, first save refused: ${refuseFirst}, aliases: ${aliases})`, async () => {
		const disk = await setup({ 'a.md': before });
		const { folder, other, writes } = disk;
		const text = folder.files.edit('a.md');
		const seen = await disk.observe('a.md');
		text.changeFields(seen, aliases ? { title: undefined } : { title: 'mine' });
		if (!aliases) expectOk(await other.files.write('a.md', before, external));
		const started = disk.hold();
		if (refuseFirst) disk.refuse(true);
		const fieldSave = text.save();
		await started;
		let observed = seen;
		if (aliases) {
			// The accumulated patch resolves the alias after removing its anchor.
			text.changeFields(seen, { link: 'independent' });
			expectOk(await other.files.write('a.md', before, aliased));
			observed = await disk.observe('a.md');
		}
		const view = text.shown(observed);
		if (view.text === undefined) throw new Error('The field overlay was lost');
		expectOk(text.change(view.source, `${view.text}my appended line\n`));
		disk.release();
		await fieldSave;
		disk.refuse(false);
		if (aliases)
			expect(
				readDocument('a.md', encode((await disk.stored('a.md')) ?? '')).fields,
			).toEqual({ link: 'before' });
		expect(text.pending).toMatchObject({ kind: 'text', error: undefined });

		if (revert) {
			const held = text.shown(observed);
			if (held.text === undefined) throw new Error('The source edit was lost');
			expectOk(
				text.change(
					held.source,
					held.text.replace('title: mine', 'title: before'),
				),
			);
		}
		await text.save();
		expect(text.pending).toBeUndefined();
		if (refuseFirst) expect(writes[1]?.from).toEqual(seen);
		const stored = (await disk.stored('a.md')) ?? '';
		if (aliases)
			expect(readDocument('a.md', encode(stored)).fields).toEqual({
				link: 'independent',
			});
		else expect(stored).toContain(revert ? 'title: before' : 'title: mine');
		expect(stored).toContain('body from another writer');
		expect(stored).toContain('my appended line');
	});
}

test.each([false, true])(
	'text typed in a view that did not show held fields keeps them (fields saving meanwhile: %s)',
	async (saving) => {
		const disk = await setup({
			'a.md': '---\ntitle: before\nlink: before\n---\nbody\n',
		});
		const text = disk.folder.files.edit('a.md');
		const old = text.shown(await disk.observe('a.md'));
		text.changeFields(old.source, { title: 'mine' });
		text.changeFields(old.source, { link: 'mine too' });
		let fieldSave: Promise<void> | undefined;
		if (saving) {
			const started = disk.hold();
			fieldSave = text.save();
			await started;
		}
		expectOk(text.change(old.source, `${old.text}append\n`));
		expect(text.pending).toMatchObject({
			kind: 'text',
			text: '---\ntitle: mine\nlink: mine too\n---\nbody\nappend\n',
		});
		disk.release();
		await fieldSave;
		await text.save();
		expect(await disk.stored('a.md')).toBe(
			'---\ntitle: mine\nlink: mine too\n---\nbody\nappend\n',
		);
	},
);

test('text typed in a view that showed the held fields can revert them', async () => {
	const disk = await setup({ 'a.md': '---\ntitle: before\n---\nbody\n' });
	const text = disk.folder.files.edit('a.md');
	const seen = await disk.observe('a.md');
	text.changeFields(text.shown(seen).source, { title: 'mine' });
	const view = text.shown(seen);
	expect(view.text).toBe('---\ntitle: mine\n---\nbody\n');
	text.change(view.source, '---\ntitle: before\n---\nbody\nappend\n');
	await text.save();
	expect(await disk.stored('a.md')).toBe(
		'---\ntitle: before\n---\nbody\nappend\n',
	);
});

test.each([false, true])(
	'fields typed while text saves go into the text, from the right next base (first save refused: %s)',
	async (refused) => {
		const disk = await setup({
			'nested/a.md': '---\ntitle: before\nobsolete: old\n---\noriginal body\n',
		});
		const { folder, writes } = disk;
		const text = folder.files.edit('nested/a.md');
		const seen = await disk.observe('nested/a.md');
		const typed = decode(seen).replace('original body', 'body typed in Files');
		text.change(seen, typed);
		const started = disk.hold();
		disk.refuse(refused);
		const first = text.save();
		await started;
		expect(writes[0]?.from).toEqual(seen);
		expectOk(
			text.changeFields(seen, {
				title: 'changed in grid',
				obsolete: undefined,
			}),
		);
		disk.release();
		await first;
		disk.refuse(false);
		const held = text.pending;
		if (held?.kind !== 'text') throw new Error('The text was lost');
		expect(held.text).toContain('body typed in Files');
		expect(held.text).toContain('title: changed in grid');
		expect(held.text).not.toContain('obsolete:');

		await text.save();
		expect(writes[1]?.from).toEqual(refused ? seen : typed);
		expect(writes[1]?.content).toBe(held.text);
		expect(text.pending).toBeUndefined();
	},
);

test('held fields show over a fresh body, and a failed patch saves again only on retry', async () => {
	const disk = await setup({
		'a.md': '---\ntitle: before\n---\nbody before\n',
	});
	const { folder, other, writes } = disk;
	const text = folder.files.edit('a.md');
	expectOk(text.changeFields(await disk.observe('a.md'), { title: 'mine' }));
	const remote = '---\ntitle: before\nother: remote\n---\nbody remote\n';
	expectOk(
		await other.files.write(
			'a.md',
			'---\ntitle: before\n---\nbody before\n',
			remote,
		),
	);
	const fresh = await disk.observe('a.md');
	expect(text.shown(fresh).text).toContain('body remote');
	expect(text.shown(fresh).text).toContain('title: mine');

	disk.refuse(true);
	await text.save();
	await folder.settle();
	expect(writes[0]?.content).toContain('other: remote');
	expect(writes[0]?.content).toContain('body remote');
	expect(text.pending?.error?.name).toBe('StorageFailed');
	expect(expectErr(text.change(fresh, 'repair')).name).toBe('FieldsUnsaved');
	await folder.settle();
	await text.save();
	expect(writes).toHaveLength(1);

	disk.refuse(false);
	await text.retry();
	expect(text.pending).toBeUndefined();
	expect(await disk.stored('a.md')).toContain('title: mine');
});

test('text typed over held fields keeps the latest body; fields over malformed source stay as fields', async () => {
	const disk = await setup({ 'a.md': '---\ntitle: before\n---\nbody\n' });
	const { folder, other } = disk;
	const text = folder.files.edit('a.md');
	text.changeFields(await disk.observe('a.md'), { title: 'mine' });
	expectOk(
		await other.files.write(
			'a.md',
			'---\ntitle: before\n---\nbody\n',
			'---\ntitle: before\n---\nnew body\n',
		),
	);
	const view = text.shown(await disk.observe('a.md'));
	expectOk(text.change(view.source, `${view.text}typed\n`));
	await text.save();
	expect(await disk.stored('a.md')).toBe(
		'---\ntitle: mine\n---\nnew body\ntyped\n',
	);

	text.changeFields(await disk.observe('a.md'), { title: 'second' });
	expectOk(
		await other.files.write(
			'a.md',
			'---\ntitle: mine\n---\nnew body\ntyped\n',
			'---\ntitle: [\n---\nbroken\n',
		),
	);
	const broken = await disk.observe('a.md');
	const pending = text.pending;
	expect(expectErr(text.change(broken, 'repair')).name).toBe('InvalidFields');
	expect(text.pending).toBe(pending);
	expect(text.pending).toMatchObject({
		kind: 'fields',
		fields: { title: 'second' },
		error: undefined,
	});
	expect(text.shown(broken).text).toBeUndefined();
	const [unsaved] = await folder.settle();
	expect(unsaved).toMatchObject({
		kind: 'fields',
		fields: { title: 'second' },
		error: { name: 'Unparseable' },
	});
	expect(text.discard()).toBe(unsaved as never);
});

test('a failed patch keeps removal apart from null, then retries over fresh source with its mark and line ends', async () => {
	const path = 'nested/tasks/a.md';
	const first = '﻿---\r\nobsolete: old\r\nunknown: keep\r\n---\r\nbody\r\n';
	const disk = await setup({ [path]: first });
	const { folder, other, writes } = disk;
	const text = folder.files.edit(path);
	expectOk(
		text.changeFields(await disk.observe(path), {
			obsolete: undefined,
			destination: null,
		}),
	);
	disk.refuse(true);
	await text.save();
	const [held] = await folder.settle();
	if (held?.kind !== 'fields')
		throw new Error('The failed field patch was lost');
	expect(Object.hasOwn(held.fields, 'obsolete')).toBe(true);
	expect(held.fields).toEqual({ obsolete: undefined, destination: null });
	expect(writes).toHaveLength(1);

	const second =
		'﻿---\r\nobsolete: changed externally\r\nunknown: keep\r\nremote: added\r\n---\r\nbody from another writer\r\n';
	expectOk(await other.files.write(path, first, second));
	disk.refuse(false);
	await text.retry();
	const stored = (await disk.stored(path)) ?? '';
	const document = readDocument(path, encode(stored));
	expect(document.fields).toEqual({
		unknown: 'keep',
		remote: 'added',
		destination: null,
	});
	expect(document.body).toContain('body from another writer');
	expect(stored.startsWith('﻿')).toBe(true);
	expect(stored.replaceAll('\r\n', '')).not.toContain('\n');
	expect(text.pending).toBeUndefined();
});

test('close keeps failed patches, including one whose missing file was recreated', async () => {
	const disk = await setup({ 'a.md': '---\ntitle: before\n---\nbody\n' });
	const { folder, other, writes } = disk;
	const text = folder.files.edit('a.md');
	text.changeFields(await disk.observe('a.md'), { title: 'mine' });
	disk.refuse(true);
	await text.save();
	await folder.settle();
	expect(writes).toHaveLength(1);
	disk.refuse(false);

	const gone = folder.files.edit('b.md');
	expectOk(await other.files.write('b.md', null, '---\ntitle: b\n---\n'));
	gone.changeFields(await disk.observe('b.md'), { title: 'mine' });
	expectOk(await other.files.delete('b.md', '---\ntitle: b\n---\n'));
	await gone.save();
	expect(gone.pending?.error?.name).toBe('Unparseable');
	expectOk(
		await other.files.write('b.md', null, '---\ntitle: new\n---\nfresh\n'),
	);

	const unsaved = await folder.close();
	expect(unsaved).toMatchObject([
		{ kind: 'fields', path: 'a.md', error: { name: 'StorageFailed' } },
		{ kind: 'fields', path: 'b.md', error: { name: 'Unparseable' } },
	]);
	expect(writes).toHaveLength(1);
	expect(await disk.stored('a.md')).toBe('---\ntitle: before\n---\nbody\n');
	expect(await disk.stored('b.md')).toBe('---\ntitle: new\n---\nfresh\n');
});

// ============================================================================
// Exclusive changes
// ============================================================================

test('an exclusive change taken before close finishes its own write through its file, which then ends', async () => {
	const disk = await setup({ 'epicenter.json': '{}' });
	const { folder, writes } = disk;
	const source = folder.files.edit('epicenter.json');
	const refused: unknown[] = [];
	folder.onStatusChange((status) => {
		// While the exclusive change's own write runs during close.
		if (!status.saving || !status.closing) return;
		try {
			void folder.files.write('reentrant.md', null, 'late');
		} catch (cause) {
			refused.push(cause);
		}
	});
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	let held: ExclusiveFile | undefined;
	const operation = source.exclusive(async (file) => {
		held = file;
		entered.resolve();
		await gate.promise;
		const before = expectOk(await file.read());
		return file.write(
			before === undefined ? null : await fileBytes(before.content),
			'{"views":{}}',
		);
	});
	await entered.promise;
	let closed = false;
	const closing = folder.close().then((unsaved) => {
		closed = true;
		return unsaved;
	});
	await Bun.sleep(5);
	expect(closed).toBe(false);
	expect(() => folder.files.write('other.md', null, 'refused')).toThrow(
		'The folder is closed',
	);

	gate.resolve();
	expect(expectOk(await operation).error).toBeNull();
	expect(await closing).toEqual([]);
	expect(await disk.stored('epicenter.json')).toBe('{"views":{}}');
	expect(writes.map(({ path }) => path)).toEqual(['epicenter.json']);
	expect(refused.length).toBeGreaterThan(0);
	expect(() => held?.read()).toThrow('has ended');
});

test('exclusive fences input at once, sends held input first, and settle waits for it', async () => {
	const disk = await setup({ 'epicenter.json': '{}' });
	const { folder } = disk;
	const source = folder.files.edit('epicenter.json');
	source.change(await disk.observe('epicenter.json'), '{"title":"mine"}');
	const started = disk.hold();
	const finish = Promise.withResolvers<void>();
	let changed = false;
	const operation = source.exclusive(async () => {
		changed = true;
		await finish.promise;
		return 'done';
	});
	expect(source.locked).toBe(true);
	expectErr(source.change(undefined, 'untracked typing'));
	expect(source.discard()).toBeUndefined();
	// Leaving the field does not wait for the fence's own save.
	await source.save();
	expect(changed).toBe(false);
	await started;
	disk.release();
	for (let turn = 0; turn < 50 && !changed; turn++) await Bun.sleep(1);
	expect(changed).toBe(true);

	let settled = false;
	const settling = folder.settle().then(() => {
		settled = true;
	});
	await Bun.sleep(0);
	expect(settled).toBe(false);
	expect(expectErr(await source.exclusive(async () => {}))).toMatchObject({
		name: 'NotStarted',
		reason: BUSY,
	});
	finish.resolve();
	expect(expectOk(await operation)).toBe('done');
	await settling;
	expect(source.locked).toBe(false);
	expect(folder.status).toMatchObject({ saving: false, unsaved: [] });
	expect(await disk.stored('epicenter.json')).toBe('{"title":"mine"}');
});

test('held input that does not save refuses the exclusive change and stays readable', async () => {
	const disk = await setup({ 'epicenter.json': '{}' });
	const source = disk.folder.files.edit('epicenter.json');
	source.change(await disk.observe('epicenter.json'), 'my source');
	disk.refuse(true);
	let changed = false;
	const refused = expectErr(
		await source.exclusive(async () => {
			changed = true;
		}),
	);
	expect(refused).toMatchObject({ name: 'NotStarted', reason: UNSAVED });
	expect(changed).toBe(false);
	expect(source.pending).toMatchObject({ kind: 'text', text: 'my source' });
	expect(source.locked).toBe(false);
	expect(source.discard()).toMatchObject({ text: 'my source' });
});

test('a failed exclusive change releases its path while another file saves independently', async () => {
	const disk = await setup({ 'epicenter.json': '{}', 'notes/a.md': 'a' });
	const { folder } = disk;
	const source = folder.files.edit('epicenter.json');
	const other = folder.files.edit('notes/a.md');
	const gate = Promise.withResolvers<void>();
	const operation = source.exclusive(async () => {
		await gate.promise;
		throw new Error('The view changed in another window');
	});
	expectErr(source.change(await disk.observe('epicenter.json'), 'blocked'));
	expectOk(other.change(await disk.observe('notes/a.md'), 'independent edit'));
	await other.save();
	expect(other.pending).toBeUndefined();
	expect(source.locked).toBe(true);

	let settled = false;
	const settling = folder.settle().then(() => {
		settled = true;
	});
	await Bun.sleep(0);
	expect(settled).toBe(false);
	gate.resolve();
	await expect(operation).rejects.toThrow('another window');
	await settling;
	expect(source.locked).toBe(false);
	expectOk(source.change(await disk.observe('epicenter.json'), 'repair'));
	expect(source.discard()).toMatchObject({ text: 'repair' });
	expect(folder.status).toMatchObject({ saving: false, unsaved: [] });
});
