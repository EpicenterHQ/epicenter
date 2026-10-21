/**
 * Source-draft handoff and fence tests
 *
 * Drives `folder.files.edit(path)` on any Markdown path of a real browser
 * folder (in-memory IndexedDB), with a second handle as another writer. The
 * engine's `write` is replaced below the handle to hold or refuse saves.
 *
 * Covers command order while saving, owned nested field values, and `run`
 * reservations around held source.
 */
import { unsavedOf } from './edit-buffer.test-support.js';
import 'fake-indexeddb/auto';
import { afterEach, expect, test } from 'bun:test';
import { IDBFactory as FakeIndexedDB } from 'fake-indexeddb';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { openRepository } from './browser/repository.js';
import { openFolder } from './browser.js';
import { BUSY, UNSAVED } from './edits.js';
import type { FileContent } from './folder.js';
import type { FolderEngine } from './handle.js';
import { folderHandle } from './handle.js';
import { SaveError } from './shared/errors.js';

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
	engine.files.write = async (
		path,
		from,
		content,
		fields,
		checkBody,
		replaceExact,
	) => {
		writes.push({ path, from, content });
		started.resolve();
		if (gate !== undefined) await gate.promise;
		if (refusing)
			return SaveError.StorageFailed({ cause: new Error('disk full') });
		return write(path, from, content, fields, checkBody, replaceExact);
	};
	cleanup.push(() => gate?.resolve());

	/** Resolves once this folder heard another handle change `path`. */
	const heard = (path: string) =>
		new Promise<void>((resolve) => {
			const stop = folder.onChange((change) => {
				if (change.origin === 'other-handle' && change.paths?.includes(path)) {
					stop();
					resolve();
				}
			});
		});

	return {
		folder,
		engine,
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
		/** Another writer's save, once this folder heard it. */
		async elsewhere(
			path: string,
			from: FileContent | null,
			content: FileContent,
		) {
			const notice = heard(path);
			expectOk(await other.files.write(path, from, content));
			await notice;
		},
		/**
		 * Another writer's save that this folder hears, but whose reread never
		 * answers, so what the person sees lacks it.
		 */
		async unseen(path: string, from: FileContent | null, content: FileContent) {
			const read = engine.files.read;
			let hung = false;
			engine.files.read = (target) => {
				if (hung || target !== path) return read(target);
				hung = true;
				return new Promise(() => {});
			};
			const notice = heard(path);
			expectOk(await other.files.write(path, from, content));
			await notice;
			// Give the reread its turn to start.
			await Bun.sleep(0);
			engine.files.read = read;
		},
		/** What is stored at `path`, read by the other writer. */
		async stored(path: string) {
			const file = expectOk(await other.files.read(path));
			if (file === undefined) return undefined;
			return decode(new Uint8Array(await file.content.arrayBuffer()));
		},
	};
}

const before = '---\ntitle: before\nlink: before\n---\nbody before\n';

test('a structured patch requires a known source; missing and binary sources refuse it', async () => {
	const disk = await setup({ 'a.md': '---\ntitle: before\n---\nbody\n' });
	const { folder } = disk;
	// A document read admits the exact source before accepting a patch.
	const unread = folder.files.edit('a.md');
	expect(expectErr(unread.change({ fields: { title: 'unread' } })).name).toBe(
		'NoSource',
	);
	expectOk(await folder.files.read('a.md'));
	expectOk(unread.change({ fields: { title: 'unread' } }));
	expect(unread.getMarkdown()?.fields?.title).toBe('unread');
	await unread.save();
	expect(await disk.stored('a.md')).toBe('---\ntitle: unread\n---\nbody\n');

	const missing = folder.files.edit('missing.md');
	expectOk(await missing.read());
	expect(missing.getText()).toBeUndefined();
	expect(expectErr(missing.change({ fields: { title: 'x' } })).name).toBe(
		'NoSource',
	);
	expect(unsavedOf(missing)).toBeUndefined();

	expectOk(await folder.files.write('raw.md', null, new Uint8Array([255, 0])));
	const raw = folder.files.edit('raw.md');
	await raw.read();
	expect(expectErr(raw.change({ fields: { title: 'x' } })).name).toBe(
		'NotText',
	);
	expect(folder.getStatus().unsaved).toEqual([]);
});
test.each([false, true])(
	'text typed over held fields starts from them (fields saving meanwhile: %s)',
	async (saving) => {
		const disk = await setup({
			'a.md': '---\ntitle: before\nlink: before\n---\nbody\n',
		});
		const text = disk.folder.files.edit('a.md');
		await text.read();
		text.change({ fields: { title: 'mine' } });
		text.change({ fields: { link: 'mine too' } });
		let fieldSave: Promise<unknown> | undefined;
		if (saving) {
			const started = disk.hold();
			fieldSave = text.save();
			await started;
		}
		expect(text.getText()).toBe(
			'---\ntitle: mine\nlink: mine too\n---\nbody\n',
		);
		expectOk(text.replaceText(`${text.getText()}append\n`));
		expect(text.getText()).toBe(
			'---\ntitle: mine\nlink: mine too\n---\nbody\nappend\n',
		);
		disk.release();
		await fieldSave;
		await text.save();
		expect(await disk.stored('a.md')).toBe(
			'---\ntitle: mine\nlink: mine too\n---\nbody\nappend\n',
		);
	},
);

test('text typed over the held fields can revert them', async () => {
	const disk = await setup({ 'a.md': '---\ntitle: before\n---\nbody\n' });
	const text = disk.folder.files.edit('a.md');
	await text.read();
	text.change({ fields: { title: 'mine' } });
	expect(text.getText()).toBe('---\ntitle: mine\n---\nbody\n');
	text.replaceText('---\ntitle: before\n---\nbody\nappend\n');
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
		expectOk(await text.read());
		const seen = text.getText() ?? '';
		const typed = seen.replace('original body', 'body typed in Files');
		text.replaceText(typed);
		const started = disk.hold();
		disk.refuse(refused);
		const first = text.save();
		await started;
		expect(writes[0]?.from).toEqual(encode(seen));
		expectOk(
			text.change({
				fields: {
					title: 'changed in grid',
					obsolete: undefined,
				},
			}),
		);
		disk.release();
		await first;
		disk.refuse(false);
		const held = unsavedOf(text);
		if (held === undefined) throw new Error('The text was lost');
		expect(text.getText()).toContain('body typed in Files');
		expect(text.getText()).toContain('title: changed in grid');
		expect(text.getText()).not.toContain('obsolete:');

		await text.save();
		expect(writes[1]?.from).toEqual(refused ? encode(seen) : typed);
		expect(writes[1]?.content).toBe(text.getText());
		expect(unsavedOf(text)).toBeUndefined();
	},
);

test('work admitted before close writes its reserved path through the folder while close waits', async () => {
	const disk = await setup({ 'epicenter.json': '{}' });
	const { folder, writes } = disk;
	const source = folder.files.edit('epicenter.json');
	const entered = Promise.withResolvers<void>();
	const gate = Promise.withResolvers<void>();
	const operation = folder.run([source.path], async () => {
		entered.resolve();
		await gate.promise;
		const before = expectOk(await folder.files.read(source.path));
		return folder.files.write(
			source.path,
			before === undefined
				? null
				: new Uint8Array(await before.content.arrayBuffer()),
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
	expect(expectErr(source.replaceText('{"title":"late"}')).name).toBe('Locked');

	gate.resolve();
	expectOk(expectOk(await operation));
	expect(await closing).toEqual([]);
	expect(await disk.stored('epicenter.json')).toBe('{"views":{}}');
	expect(writes.map(({ path }) => path)).toEqual(['epicenter.json']);
	expect(() => folder.files.write('other.md', null, 'refused')).toThrow(
		'The folder is closed',
	);
});

test('a reservation locks input at once, sends held input first, and settle waits for it', async () => {
	const disk = await setup({ 'epicenter.json': '{}' });
	const { folder } = disk;
	const source = folder.files.edit('epicenter.json');
	await source.read();
	source.replaceText('{"title":"mine"}');
	const started = disk.hold();
	const finish = Promise.withResolvers<void>();
	let changed = false;
	const operation = folder.run([source.path], async () => {
		changed = true;
		await finish.promise;
		return 'done';
	});
	expect(source.isLocked()).toBe(true);
	expectErr(source.replaceText('untracked typing'));
	expect(expectErr(source.discard()).name).toBe('NotStarted');
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
	expect(
		expectErr(await folder.run([source.path], async () => {})),
	).toMatchObject({
		name: 'NotStarted',
		reason: BUSY,
	});
	finish.resolve();
	expect(expectOk(await operation)).toBe('done');
	await settling;
	expect(source.isLocked()).toBe(false);
	expect(folder.getStatus()).toMatchObject({ saving: false, unsaved: [] });
	expect(await disk.stored('epicenter.json')).toBe('{"title":"mine"}');
	expect(source.getText()).toBe('{"title":"mine"}');
});

test('held input that does not save refuses reserved work and stays readable', async () => {
	const disk = await setup({ 'epicenter.json': '{}' });
	const { folder } = disk;
	const source = folder.files.edit('epicenter.json');
	await source.read();
	source.replaceText('my source');
	disk.refuse(true);
	let changed = false;
	const refused = expectErr(
		await folder.run([source.path], async () => {
			changed = true;
		}),
	);
	expect(refused).toMatchObject({ name: 'NotStarted', reason: UNSAVED });
	expect(changed).toBe(false);
	expect(source.getText()).toBe('my source');
	expect(source.isLocked()).toBe(false);
	expect(expectOk(source.discard())).toMatchObject({ text: 'my source' });
	expect(source.getText()).toBe('{}');
});

test('failed reserved work releases its path while another file saves independently', async () => {
	const disk = await setup({ 'epicenter.json': '{}', 'notes/a.md': 'a' });
	const { folder } = disk;
	const source = folder.files.edit('epicenter.json');
	const other = folder.files.edit('notes/a.md');
	await source.read();
	await other.read();
	const gate = Promise.withResolvers<void>();
	const operation = folder.run([source.path], async () => {
		await gate.promise;
		throw new Error('The view changed in another window');
	});
	expect(expectErr(source.replaceText('blocked')).name).toBe('Locked');
	expectOk(other.replaceText('independent edit'));
	await other.save();
	expect(unsavedOf(other)).toBeUndefined();
	expect(source.isLocked()).toBe(true);

	let settled = false;
	const settling = folder.settle().then(() => {
		settled = true;
	});
	await Bun.sleep(0);
	expect(settled).toBe(false);
	gate.resolve();
	await expect(operation).rejects.toThrow('another window');
	await settling;
	expect(source.isLocked()).toBe(false);
	expectOk(source.replaceText('repair'));
	expect(expectOk(source.discard())).toMatchObject({ text: 'repair' });
	expect(folder.getStatus()).toMatchObject({ saving: false, unsaved: [] });
});

test('accepted nested fields are owned copies in the source draft', async () => {
	const disk = await setup({ 'a.md': before });
	const edit = disk.folder.files.edit('a.md');
	expectOk(await edit.read());
	const payload = new Proxy(
		{ tags: new Proxy(['accepted'], {}), options: { level: 1 } },
		{},
	);
	expectOk(edit.change({ fields: { payload } }));
	payload.tags.push('mutated after acceptance');
	payload.options.level = 9;
	expect(edit.getMarkdown()?.fields?.payload).toEqual({
		tags: ['accepted'],
		options: { level: 1 },
	});
	await edit.save();
	expect(unsavedOf(edit)).toBeUndefined();
	expect(edit.getMarkdown()?.fields?.payload).toEqual({
		tags: ['accepted'],
		options: { level: 1 },
	});
});

test('nested values accepted while saving remain owned through the next save', async () => {
	const disk = await setup({ 'a.md': before });
	const edit = disk.folder.files.edit('a.md');
	expectOk(await edit.read());
	const first = { values: ['first'] };
	expectOk(edit.change({ fields: { payload: first } }));
	const started = disk.hold();
	const saving = edit.save();
	await started;
	const next = { values: ['next'] };
	expectOk(edit.change({ fields: { payload: next } }));
	first.values.push('changed while saving');
	next.values.push('changed after acceptance');
	disk.release();
	await saving;
	await edit.save();
	expect(unsavedOf(edit)).toBeUndefined();
	expect(edit.getMarkdown()?.fields?.payload).toEqual({ values: ['next'] });
});
