/**
 * Edit Layer Tests
 *
 * `createEdits` holds what a person typed and has not saved, once per
 * opened folder, over the folder's ordered writes. These drive it through
 * `createFolderContext` over a browser folder on the in-memory OPFS
 * stand-in, with a recorded `writeFailed` in place of the toast.
 *
 * Key behaviors:
 * - A body typed saves a second after the last change, or at once, and the
 *   draft is let go once it is in the file
 * - A draft outlives its view: a read that lands while it is held never
 *   replaces it
 * - A body save that fails keeps the text on screen and is reported with it;
 *   Save again saves it, and starts nothing once the folder closes
 * - A body typed into a row deleted elsewhere is let go and offered once,
 *   as soon as a listing without the row lands
 * - A file's text whose save fails stays typed; one whose file was deleted
 *   is let go and offered
 * - A typed field saves and clears once in the file; a failed one keeps the
 *   value, reported with it; one set on a deleted row offers the text, and
 *   a click on a deleted row reports nothing
 * - A rename or delete runs once the path's drafts landed and refuses edits
 *   meanwhile
 * - Save version starts once every draft and write landed, and commits what
 *   they wrote
 * - Close fences input at once and waits for every draft, write, and app
 *   action; every call shares one completion
 */
import './svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { defineFolder, defineTable, field } from '@epicenter/folder';
import { openFolder } from '@epicenter/folder/browser';
import { MutationObserver, QueryObserver } from '@tanstack/query-core';
import { Ok } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import {
	browserStorage,
	createTestStorage,
} from '../../folder/src/browser-storage.test-support.js';
import { useWebLocks } from '../../folder/src/web-locks.test-support.js';
import type { WriteFailure } from './write-failure.js';

const { flushSync } = await import('svelte');
const { createFolderContext } = await import('./folder-context.js');
const { CLOSING } = await import('./edits.svelte.js');

const definition = defineFolder({
	tables: {
		notes: defineTable({
			fields: { title: field.string(), pinned: field.boolean() },
		}),
	},
});

const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const step of cleanup.splice(0).reverse()) await step();
});

let count = 0;

/** Whether the folder's `write` refuses, in a context set up with `refusable`. */
const refusing = { write: false };

/**
 * A context over a fresh folder holding the note `a`, its listing observed.
 * With `refusable`, the context's folder refuses each `write` while
 * `refusing.write` is set.
 */
async function setup({ refusable = false } = {}) {
	const storage = createTestStorage();
	refusing.write = false;
	const opened = expectOk(
		await openFolder({
			app: `so.epicenter.edits-test-${count++}`,
			definition,
			browser: {
				author: { name: 'Edits', email: 'edits@example.test' },
				...browserStorage(storage),
			},
		}),
	);
	const folder: typeof opened = refusable
		? Object.create(opened, {
				write: {
					value: (...args: Parameters<typeof opened.write>) =>
						refusing.write
							? Promise.resolve({
									data: null,
									error: { name: 'Io', message: 'disk full' },
								})
							: opened.write(...args),
				},
			})
		: opened;
	const failures: WriteFailure[] = [];
	const context = createFolderContext(folder, {
		writeFailed: (failure) => failures.push(failure),
	});
	cleanup.push(() => context.close());
	expectOk(
		await folder.tables.notes.create(
			{ fields: { title: 'A', pinned: false }, body: 'One.\n' },
			{ stem: 'a' },
		),
	);
	const stop = new QueryObserver(
		context.queryClient,
		context.queries.notes.list.queryOptions(),
	).subscribe(() => {});
	cleanup.push(stop);
	await context.queryClient.fetchQuery(
		context.queries.notes.list.queryOptions(),
	);
	return { folder, context, edits: context.edits, failures };
}

/** The note `stem`'s file as the folder holds it now. */
async function stored(
	folder: Awaited<ReturnType<typeof setup>>['folder'],
	stem: string,
) {
	const { data } = await folder.tables.notes.get(stem);
	return data?.row;
}

/** Wait until `check` holds, letting effects and timers run between tries. */
async function until(check: () => boolean, what: string) {
	for (let tries = 0; tries < 300; tries++) {
		flushSync();
		if (check()) return;
		await Bun.sleep(5);
	}
	throw new Error(`Timed out waiting for ${what}`);
}

test('a body typed saves a second after the last change, and is let go once in the file', async () => {
	const { folder, edits } = await setup();
	const body = edits.body('notes', 'a');
	expect(body.text).toBe('One.\n');

	expect(body.change('One.\nTwo.\n')).toBe(true);
	expect(body.typed).toBe('One.\nTwo.\n');
	expect(body.saving).toBe(true);
	expect(edits.writing('notes/a.md')).toBe(true);
	expect((await stored(folder, 'a'))?.body).toBe('One.\n');

	await until(() => body.typed === undefined, 'the save after a pause');
	expect((await stored(folder, 'a'))?.body).toBe('One.\nTwo.\n');
	expect(body.text).toBe('One.\nTwo.\n');
	expect(edits.writing()).toBe(false);
});

test('a read that lands while a body is held does not replace it', async () => {
	const { folder, context, edits } = await setup();
	const body = edits.body('notes', 'a');
	body.change('Mine.\n');
	expectOk(await folder.tables.notes.set('a', { title: 'Theirs' }));
	await context.queryClient.invalidateQueries(
		context.queries.pathFilter(['notes/a.md']),
	);
	await until(
		() => context.queryClient.isFetching() === 0,
		'the listing read again',
	);
	expect(body.text).toBe('Mine.\n');

	await body.save();
	expect(await stored(folder, 'a')).toEqual({
		fields: { title: 'Theirs', pinned: false },
		body: 'Mine.\n',
	});
});

test('a body save that fails keeps the text and is reported with it; Save again saves it, and starts nothing once closing', async () => {
	const { folder, context, edits, failures } = await setup();
	const write = folder.tables.notes.write;
	let refuse = true;
	folder.tables.notes.write = (async (...args: Parameters<typeof write>) =>
		refuse
			? { data: null, error: { name: 'Io', message: 'disk full' } }
			: write(...args)) as typeof write;
	const body = edits.body('notes', 'a');
	body.change('Typed.\n');

	await body.save();
	expect(body.typed).toBe('Typed.\n');
	expect(body.failed).toBe(true);
	expect(body.error?.name).toBe('Io');
	expect(edits.unsaved('notes/a.md')).toBe(true);
	expect(failures).toHaveLength(1);
	expect(failures[0]?.unsaved).toBe('Typed.\n');

	refuse = false;
	expect(failures[0]?.retry?.()).toBe(true);
	await edits.settled();
	expect(body.typed).toBe(undefined);
	expect((await stored(folder, 'a'))?.body).toBe('Typed.\n');

	refuse = true;
	body.change('Again.\n');
	await body.save();
	const closing = context.close();
	expect(failures.at(-1)?.retry?.()).toBe(false);
	refuse = false;
	await closing;
});

test('a body typed into a row deleted elsewhere is let go and offered once, as soon as a listing without it lands', async () => {
	const { folder, context, edits, failures } = await setup();
	const body = edits.body('notes', 'a');
	body.change('Mine.\n');
	expectOk(await folder.tables.notes.delete('a'));

	await context.queryClient.invalidateQueries(
		context.queries.pathFilter(['notes/a.md']),
	);
	await until(() => failures.length > 0, 'the offer');
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({
		path: 'notes/a.md',
		unsaved: 'Mine.\n',
		error: { name: 'NotFound' },
	});
	expect(body.typed).toBe(undefined);
	await edits.settled();
	expect(await stored(folder, 'a')).toBe(undefined);
	expect(failures).toHaveLength(1);
});

test("a file's text whose save fails stays typed; one whose file was deleted is let go and offered", async () => {
	const { folder, context, edits, failures } = await setup({
		refusable: true,
	});
	expectOk(await folder.write('note.txt', null, 'one\n'));
	await context.queryClient.fetchQuery(
		context.queries.files.text.queryOptions('note.txt'),
	);
	const text = edits.text('note.txt');
	refusing.write = true;
	text.change('two\n');
	await text.save();
	expect(text.typed).toBe('two\n');
	expect(failures.at(-1)?.unsaved).toBe('two\n');

	refusing.write = false;
	expectOk(await folder.write('note.txt', 'one\n', null));
	await text.save();
	expect(text.typed).toBe(undefined);
	expect(failures.at(-1)).toMatchObject({
		path: 'note.txt',
		unsaved: 'two\n',
		error: { name: 'NotFound' },
	});
	expect((await folder.files.read('note.txt')).error?.name).toBe('NotFound');
});

test('a typed field saves and clears once in the file; a failed one keeps the value, reported with it', async () => {
	const { folder, edits, failures } = await setup();
	const title = edits.field('notes', 'a', 'title');
	expect(title.change('B')).toBe(true);
	expect(title.shown('A')).toBe('B');
	await title.save();
	expect(title.typed).toBe(undefined);
	expect(title.shown('B')).toBe('B');
	expect((await stored(folder, 'a'))?.fields.title).toBe('B');

	const set = folder.tables.notes.set;
	folder.tables.notes.set = (async () => ({
		data: null,
		error: { name: 'Io', message: 'disk full' },
	})) as unknown as typeof set;
	title.change('C');
	await title.save();
	expect(title.typed).toBe('C');
	expect(title.error?.name).toBe('Io');
	expect(failures.at(-1)).toMatchObject({ path: 'notes/a.md', unsaved: 'C' });

	folder.tables.notes.set = set;
	expect(failures.at(-1)?.retry?.()).toBe(true);
	await edits.settled();
	expect(title.typed).toBe(undefined);
	expect((await stored(folder, 'a'))?.fields.title).toBe('C');
});

test('a field typed into a deleted row offers its text; a click on a deleted row reports nothing', async () => {
	const { folder, edits, failures } = await setup();
	expectOk(await folder.tables.notes.delete('a'));

	expect(edits.set('notes', 'a', { pinned: true })).toBe(undefined);
	await edits.settled();
	expect(failures).toEqual([]);

	edits.field('notes', 'a', 'title').change('Lost');
	await edits.settled();
	expect(failures).toHaveLength(1);
	expect(failures[0]).toMatchObject({
		path: 'notes/a.md',
		unsaved: 'Lost',
		error: { name: 'NotFound' },
	});
	expect(await stored(folder, 'a')).toBe(undefined);
});

test("one row's body save and field set run in the order made", async () => {
	const { folder, edits } = await setup();
	const body = edits.body('notes', 'a');
	body.change('Body.\n');
	const saving = body.save();
	edits.set('notes', 'a', { pinned: true });
	await saving;
	await edits.settled();
	expect(await stored(folder, 'a')).toEqual({
		fields: { title: 'A', pinned: true },
		body: 'Body.\n',
	});
});

test("a delete runs once the path's drafts landed, and refuses edits meanwhile", async () => {
	const { folder, edits } = await setup();
	const body = edits.body('notes', 'a');
	body.change('Last words.\n');
	let sawBody: string | undefined;
	const deleting = edits.exclusive('notes/a.md', async () => {
		sawBody = (await stored(folder, 'a'))?.body;
		return edits.writes.tables.notes.delete('a');
	});
	expect(edits.locked('notes/a.md')).toBe(true);
	expect(edits.locked('notes/b.md')).toBe(false);
	expect(body.change('Too late.\n')).toBe(false);
	expect(edits.set('notes', 'a', { pinned: true })).toBe(
		'This file is being renamed or deleted. Try again when it finishes.',
	);

	expectOk(await deleting);
	expect(sawBody).toBe('Last words.\n');
	expect(edits.locked('notes/a.md')).toBe(false);
	expect(await stored(folder, 'a')).toBe(undefined);
});

test('Save version starts once every draft and write landed, and commits what they wrote', async () => {
	const { folder, edits } = await setup();
	expectOk(await edits.saveVersion());
	edits.body('notes', 'a').change('Versioned.\n');
	edits.field('notes', 'a', 'title').change('Titled');

	const outcome = expectOk(await edits.saveVersion());
	expect(outcome.status).toBe('committed');
	const status = expectOk(await folder.git.status());
	expect(status.changes).toEqual([]);
	expect(await stored(folder, 'a')).toEqual({
		fields: { title: 'Titled', pinned: false },
		body: 'Versioned.\n',
	});
});

test('close fences input at once and waits for drafts, writes, and actions; every call shares one completion', async () => {
	const { folder, context, edits } = await setup();
	edits.body('notes', 'a').change('Sent at close.\n');
	const action = Promise.withResolvers<void>();
	const running = new MutationObserver(context.queryClient, {
		mutationFn: async () => {
			await action.promise;
			return Ok(undefined);
		},
	}).mutate();

	const first = context.close();
	const second = context.close();
	expect(second).toBe(first);
	expect(edits.fenced).toBe(true);
	expect(edits.refusal()).toBe(CLOSING);
	expect(edits.body('notes', 'a').change('Refused.\n')).toBe(false);
	expect(edits.field('notes', 'a', 'title').change('Refused')).toBe(false);
	expect((await edits.saveVersion()).error?.name).toBe('NotStarted');

	let closed = false;
	void first.then(() => {
		closed = true;
	});
	await Bun.sleep(20);
	// What was typed is in the file; the action still holds the folder open.
	expect((await stored(folder, 'a'))?.body).toBe('Sent at close.\n');
	expect(closed).toBe(false);
	action.resolve();
	await running;
	await first;
	expect((await folder.tables.notes.list()).error?.name).toBe('Closed');
});

// Commits need the shared lock; this runtime has none of its own.
useWebLocks();
