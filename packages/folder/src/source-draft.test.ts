/** Exact source drafts and guarded conflicts through both local engines. */
import { unsavedOf } from './edit-buffer.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDBFactory } from 'fake-indexeddb';
import { Type } from 'typebox';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRepository } from './browser/repository.js';
import type { FileContent, Folder } from './folder.js';
import { folderHandle } from './handle.js';
import { openBunFolder } from './native/bun.js';

const notes = Type.Object({ title: Type.Optional(Type.String()) });
const tables = { notes };
const path = 'notes/a.md';
const initial = '---\ntitle: A\n---\nfirst\n';
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

async function setup(host: 'browser' | 'native', source = initial) {
	let first: Folder<typeof tables>;
	let other: Folder<typeof tables>;
	if (host === 'browser') {
		globalThis.indexedDB = new IDBFactory();
		const id = crypto.randomUUID();
		const a = await openRepository(id, tables);
		const b = await openRepository(id, tables);
		first = folderHandle(
			{
				files: a.files,
				tables: a.tables,
				subscribe: a.onChange,
				close: a.close,
			},
			tables,
			{ saveAfterMs: 60_000 },
		);
		other = folderHandle(
			{
				files: b.files,
				tables: b.tables,
				subscribe: b.onChange,
				close: b.close,
			},
			tables,
			{ saveAfterMs: 60_000 },
		);
	} else {
		const parent = await mkdtemp(join(tmpdir(), 'source-draft-'));
		cleanup.push(() => rm(parent, { recursive: true, force: true }));
		const root = join(parent, 'folder');
		await mkdir(root);
		first = expectOk(
			await openBunFolder({ directory: root, tables, saveAfterMs: 60_000 }),
		);
		other = expectOk(
			await openBunFolder({ directory: root, tables, saveAfterMs: 60_000 }),
		);
	}
	cleanup.push(() => other.close());
	cleanup.push(() => first.close());
	expectOk(await first.files.write(path, null, source));
	const edit = first.tables.notes.edit('a');
	expectOk(await edit.read());
	const stored = async () =>
		expectOk(await other.files.read(path))?.content.text();
	const outside = async (content: FileContent) => {
		const file = expectOk(await other.files.read(path));
		const from =
			file === undefined
				? null
				: new Uint8Array(await file.content.arrayBuffer());
		expectOk(await other.files.write(path, from, content));
	};
	return { first, other, edit, stored, outside };
}

for (const host of ['browser', 'native'] as const) {
	test(`${host}: commands act in order and no-op assignments do not create intent`, async () => {
		const { edit, stored } = await setup(host);
		expectOk(edit.change({ fields: { title: 'A' } }));
		expect(unsavedOf(edit)).toBeUndefined();
		expectOk(edit.change({ body: 'first\nsecond\n' }));
		const held = unsavedOf(edit);
		const heldText = edit.getText()!;
		expect(heldText).toBe('---\ntitle: A\n---\nfirst\nsecond\n');
		expectOk(edit.change({ fields: { title: 'A' } }));
		expectOk(edit.replaceText(heldText));
		expect(unsavedOf(edit)).toBe(held);
		expectOk(edit.replaceText('---\ntitle: Source\n---\nsource\n'));
		expectOk(edit.change({ fields: { title: 'After' } }));
		expect(edit.getMarkdown()?.fields).toEqual({ title: 'After' });
		await edit.save();
		expect(unsavedOf(edit)).toBeUndefined();
		expect(await stored()).toBe(edit.getText());
	});

	test(`${host}: returning to the exact observed source clears an unsent draft`, async () => {
		const { edit, stored } = await setup(host);
		expectOk(edit.change({ body: 'changed\n' }));
		expectOk(edit.replaceText(initial));
		expect(unsavedOf(edit)).toBeUndefined();
		await edit.save();
		expect(await stored()).toBe(initial);
	});

	test(`${host}: invalid source remains exact in the Markdown snapshot after refusal`, async () => {
		const { edit, stored } = await setup(host);
		for (const input of ['a\0b', 'a\uD800b']) {
			expectOk(edit.replaceText(input));
			expect(edit.getText()).toBe(input);
			expect(edit.getMarkdown()?.text).toBe(input);
			expect(edit.getMarkdown()?.issues?.[0]?.kind).toBe('not-text');
			await edit.save();
			expect(edit.getText()).toBe(input);
			expect(unsavedOf(edit)?.error?.name).toBe('NotText');
			expect(await stored()).toBe(initial);
		}
	});

	test(`${host}: outside writes pin the draft and conflict at whole-file scope`, async () => {
		const { edit, outside, stored } = await setup(host);
		expectOk(edit.change({ body: 'mine\n' }));
		const draft = edit.getText();
		const theirs = '---\ntitle: B\n---\nfirst\n';
		await outside(theirs);
		expectOk(await edit.read());
		expect(edit.getText()).toBe(draft);
		await edit.save();
		expect(edit.getText()).toBe(draft);
		expect(unsavedOf(edit)?.error?.name).toBe('Conflict');
		expect(await stored()).toBe(theirs);
		await edit.resolveConflict('draft');
		expect(await stored()).toBe(draft);
		expect(unsavedOf(edit)).toBeUndefined();
	});

	test(`${host}: a resolution remains guarded if storage changes again`, async () => {
		const { edit, outside, stored } = await setup(host);
		expectOk(edit.replaceText('mine\n'));
		await outside('outside one\n');
		await edit.save();
		expect(unsavedOf(edit)?.error?.name).toBe('Conflict');
		await outside('outside two\n');
		await edit.resolveConflict({ text: 'resolved\n' });
		expect(unsavedOf(edit)?.error?.name).toBe('Conflict');
		expect(await stored()).toBe('outside two\n');
		await outside('outside three\n');
		await edit.resolveConflict('current');
		expect(edit.getText()).toBe('resolved\n');
		expect(unsavedOf(edit)?.error?.name).toBe('Conflict');
		await edit.resolveConflict('current');
		expect(unsavedOf(edit)).toBeUndefined();
		expect(edit.getText()).toBe('outside three\n');
	});

	test(`${host}: outside deletion and binary replacement cannot erase a dirty draft`, async () => {
		const { edit, other } = await setup(host);
		expectOk(edit.replaceText('held source\n'));
		const existing = expectOk(await other.files.read(path));
		expectOk(
			await other.files.delete(
				path,
				new Uint8Array(await existing!.content.arrayBuffer()),
			),
		);
		await edit.save();
		expect(unsavedOf(edit)?.error?.name).toBe('Conflict');
		expect(edit.getText()).toBe('held source\n');
		expectOk(await other.files.write(path, null, Uint8Array.of(0, 255)));
		await edit.save();
		expect(unsavedOf(edit)?.error?.name).toBe('Conflict');
		expect(edit.getText()).toBe('held source\n');
	});

	test(`${host}: an already identical result satisfies the draft`, async () => {
		const { edit, outside, stored } = await setup(host);
		expectOk(edit.replaceText('same\n'));
		await outside('same\n');
		await edit.save();
		expect(unsavedOf(edit)).toBeUndefined();
		expect(await stored()).toBe('same\n');
	});

	test(`${host}: headerless rows share the codec and malformed boundaries stay truthful`, async () => {
		const { first, edit, stored } = await setup(host, 'plain\n');
		expect(edit.getMarkdown()).toMatchObject({
			text: 'plain\n',
			fields: {},
			body: 'plain\n',
			issues: null,
		});
		expectOk(edit.change({ body: 'new prose\n' }));
		expect(edit.getText()).toBe('new prose\n');
		await edit.save();
		expect(await stored()).toBe('new prose\n');
		expectOk(edit.change({ fields: { title: 'Added' } }));
		expect(edit.getText()).toContain('title: Added');
		await edit.save();
		const listed = expectOk(await first.tables.notes.list());
		expect(listed[0]?.fields).toEqual({ title: 'Added' });
		const broken = '---\ntitle: [broken\n---\nknown body\n';
		expectOk(edit.replaceText(broken));
		expect(edit.getMarkdown()?.body).toBe('known body\n');
		expect(edit.getMarkdown()?.fields).toBeUndefined();
		expectOk(edit.change({ body: 'changed body\n' }));
		expect(edit.getText()).toBe('---\ntitle: [broken\n---\nchanged body\n');
		expectErr(edit.change({ fields: { title: 'No' } }));
		expectOk(edit.replaceText('---\ntitle: unfinished\n'));
		expect(edit.getMarkdown()?.body).toBeUndefined();
		expectErr(edit.change({ body: 'unavailable\n' }));
	});
}

test('typing during a committed browser save remains pending over the submitted source', async () => {
	globalThis.indexedDB = new IDBFactory();
	const id = crypto.randomUUID();
	const repository = await openRepository(id, tables);
	const files = { ...repository.files };
	const folder = folderHandle(
		{
			files,
			tables: repository.tables,
			subscribe: repository.onChange,
			close: repository.close,
		},
		tables,
		{ saveAfterMs: 60_000 },
	);
	cleanup.push(() => folder.close());
	expectOk(await folder.files.write(path, null, initial));
	const edit = folder.files.edit(path);
	expectOk(await edit.read());
	const committed = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const write = files.write;
	files.write = async (...args) => {
		const result = await write(...args);
		committed.resolve();
		await release.promise;
		return result;
	};
	cleanup.push(() => release.resolve());
	expectOk(edit.replaceText('first draft\n'));
	const saving = edit.save();
	await committed.promise;
	expect(unsavedOf(edit)?.status === 'saving').toBe(true);
	expectOk(edit.replaceText('second draft\n'));
	release.resolve();
	await saving;
	expect(edit.getText()).toBe('second draft\n');
	await edit.save();
	expect(unsavedOf(edit)).toBeUndefined();
});

test('conflict recovery keeps its private guard when displayed witness bytes are changed', async () => {
	const { edit, outside, stored } = await setup('browser');
	expectOk(edit.replaceText('mine\n'));
	await outside('theirs\n');
	await edit.save();
	const error = unsavedOf(edit)?.error;
	expect(error?.name).toBe('Conflict');
	if (error?.name !== 'Conflict' || !(error.current instanceof Uint8Array))
		throw new Error('Expected byte witness');
	error.current[0] = 0;
	await edit.resolveConflict('draft');
	expect(await stored()).toBe('mine\n');
	expect(unsavedOf(edit)).toBeUndefined();
});

test('a browser row source without a final newline saves after its observers leave', async () => {
	const { edit } = await setup('browser', '---\ntitle: Milk\n---\nTwo litres');
	expectOk(edit.change({ fields: { title: 'Oat milk' } }));
	await edit.save();
	expect(unsavedOf(edit)?.error).toBeUndefined();
	expect(unsavedOf(edit)).toBeUndefined();
});
