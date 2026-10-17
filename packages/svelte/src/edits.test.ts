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
 * - A field save that lands clears only the typing it sent, never a value
 *   typed after it that equals it (A, then B, then A)
 * - A rename or delete runs once the path's drafts landed and refuses edits
 *   meanwhile, at a rename's source and destination both
 * - Typing whose save failed blocks what would move past it: a delete or
 *   rename of its path, Save version, and typing the path another way; the
 *   failure offers Save again and Discard, and discarding unblocks
 * - A settle tries a failed save once, and answers what still did not save;
 *   typing it cannot even send is told with Discard
 * - Discard lets go of what is typed now, newer typing included, and
 *   answers it, so no typing is dropped without being offered
 * - A rename or delete that succeeded lets go of what was held at the path,
 *   so no Save again reaches a file later made there
 * - A file's text typed into a file deleted elsewhere is let go and offered
 *   once, as soon as a read without the file lands
 * - A field save whose write throws ends saving and is reported; close
 *   still completes
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
const { CLOSING, UNSAVED } = await import('./edits.svelte.js');

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

test('a field save that lands clears only the typing it sent, not the same value typed again after it (A, then B, then A)', async () => {
	const { folder, edits } = await setup();
	const set = folder.tables.notes.set;
	const gate = Promise.withResolvers<void>();
	const began = Promise.withResolvers<void>();
	let calls = 0;
	folder.tables.notes.set = (async (...args: Parameters<typeof set>) => {
		if (++calls === 1) {
			began.resolve();
			await gate.promise;
		}
		return set(...args);
	}) as typeof set;
	const title = edits.field('notes', 'a', 'title');

	title.change('First');
	const first = title.save();
	await began.promise;
	title.change('Intermediate');
	const second = title.save();
	await until(
		() => edits.writes.pending('notes/a.md') === 2,
		'the second save to wait its turn',
	);
	title.change('First');
	gate.resolve();
	await first;
	await second;
	// The first save sent "First" before "Intermediate"; what was typed last
	// is still to send.
	expect(title.typed).toBe('First');
	await edits.settled();
	expect((await stored(folder, 'a'))?.fields.title).toBe('First');
	expect(title.typed).toBe(undefined);
});

test('a rename locks its source and its destination, and lets go of what was held at both once it moved', async () => {
	const { folder, context, edits } = await setup();
	expectOk(await folder.write('note.txt', null, 'one\n'));
	await context.queryClient.fetchQuery(
		context.queries.files.text.queryOptions('note.txt'),
	);
	const source = edits.text('note.txt');
	source.change('two\n');
	let lockedDuringMove = false;
	let destinationTook = true;
	const moved = await edits.exclusive(['note.txt', 'moved.txt'], async () => {
		lockedDuringMove = edits.locked('note.txt') && edits.locked('moved.txt');
		destinationTook = edits.text('moved.txt').change('typed meanwhile\n');
		return edits.writes.move('note.txt', 'moved.txt');
	});
	expectOk(moved);
	expect(lockedDuringMove).toBe(true);
	expect(destinationTook).toBe(false);
	expect((await folder.files.read('moved.txt')).error).toBe(null);
	expect(edits.locked('moved.txt')).toBe(false);
	expect(edits.busy).toBe(false);
	expect(source.typed).toBe(undefined);
});

test('a delete refuses while typing at its path did not save; Discard lets the delete run, and no Save again reaches a file later made there', async () => {
	const { folder, context, edits, failures } = await setup({
		refusable: true,
	});
	await context.queryClient.fetchQuery(
		context.queries.files.text.queryOptions('notes/a.md'),
	);
	const text = edits.text('notes/a.md');
	refusing.write = true;
	const mine = '---\ntitle: A\npinned: false\n---\nOne.\nMINE\n';
	expect(text.change(mine)).toBe(true);
	await text.save();
	expect(text.failed).toBe(true);

	const refused = await edits.exclusive('notes/a.md', () =>
		edits.writes.tables.notes.delete('a'),
	);
	expect(refused.error).toMatchObject({ name: 'NotStarted', reason: UNSAVED });
	expect(await stored(folder, 'a')).toEqual({
		fields: { title: 'A', pinned: false },
		body: 'One.\n',
	});
	expect(text.typed).toBe(mine);
	// The settle tried the save once more, and the person is told again,
	// with the text, Save again, and Discard.
	const told = failures.at(-1);
	expect(told).toMatchObject({ path: 'notes/a.md', unsaved: mine });
	expect(told?.retry).toBeFunction();
	expect(told?.discard).toBeFunction();

	told?.discard?.();
	expect(text.typed).toBe(undefined);
	expect(edits.unsaved()).toBe(false);
	expectOk(
		await edits.exclusive('notes/a.md', () =>
			edits.writes.tables.notes.delete('a'),
		),
	);
	context.queryClient.removeQueries({
		queryKey: context.queries.files.text.queryKey('notes/a.md'),
		exact: true,
	});
	expect(edits.unsaved()).toBe(false);
	expect(edits.busy).toBe(false);

	// A new file at the path shows its own text, and the old notice saves
	// nothing into it.
	refusing.write = false;
	expectOk(
		await folder.tables.notes.create(
			{ fields: { title: 'B', pinned: false }, body: 'Brand new.\n' },
			{ stem: 'a' },
		),
	);
	await context.queryClient.fetchQuery(
		context.queries.files.text.queryOptions('notes/a.md'),
	);
	expect(text.text).toContain('Brand new.');
	expect(told?.retry?.()).toBe(false);
	await edits.settled();
	expect((await stored(folder, 'a'))?.body).toBe('Brand new.\n');
});

test('a settle tries a failed save once, and answers the paths still unsaved', async () => {
	const { folder, edits, failures } = await setup();
	const write = folder.tables.notes.write;
	folder.tables.notes.write = (async () => ({
		data: null,
		error: { name: 'Io', message: 'disk full' },
	})) as unknown as typeof write;
	edits.body('notes', 'a').change('Typed.\n');
	await edits.body('notes', 'a').save();
	expect(failures).toHaveLength(1);

	expect(await edits.settled()).toEqual(['notes/a.md']);
	expect(failures).toHaveLength(2);
	expect(await edits.settled('notes/b.md')).toEqual([]);

	folder.tables.notes.write = write;
	expect(await edits.settled()).toEqual([]);
	expect((await stored(folder, 'a'))?.body).toBe('Typed.\n');
});

test('Save version refuses while typing did not save, and commits once it is discarded', async () => {
	const { folder, edits, failures } = await setup();
	expectOk(await edits.saveVersion());
	const write = folder.tables.notes.write;
	folder.tables.notes.write = (async () => ({
		data: null,
		error: { name: 'Io', message: 'disk full' },
	})) as unknown as typeof write;
	const body = edits.body('notes', 'a');
	body.change('Must be in the version.\n');
	edits.field('notes', 'a', 'title').change('Committed');

	const refused = await edits.saveVersion();
	expect(refused.error?.name).toBe('NotStarted');
	expect(refused.error?.message).toContain('notes/a.md');
	expect(body.typed).toBe('Must be in the version.\n');
	// The field saved; only the body is held.
	expect((await stored(folder, 'a'))?.fields.title).toBe('Committed');
	expect(expectOk(await folder.git.status()).changes).not.toEqual([]);

	failures.at(-1)?.discard?.();
	expect(expectOk(await edits.saveVersion()).status).toBe('committed');
	expect((await stored(folder, 'a'))?.body).toBe('One.\n');
	folder.tables.notes.write = write;
});

test('a path is typed one way at a time: a body or field that did not save refuses its exact text, and the reverse', async () => {
	const { folder, context, edits, failures } = await setup({
		refusable: true,
	});
	await context.queryClient.fetchQuery(
		context.queries.files.text.queryOptions('notes/a.md'),
	);
	const write = folder.tables.notes.write;
	folder.tables.notes.write = (async () => ({
		data: null,
		error: { name: 'Io', message: 'disk full' },
	})) as unknown as typeof write;
	const body = edits.body('notes', 'a');
	body.change('Older body.\n');
	await body.save();
	const text = edits.text('notes/a.md');
	expect(text.change('---\ntitle: A\npinned: false\n---\nNewer.\n')).toBe(
		false,
	);
	failures.at(-1)?.discard?.();
	folder.tables.notes.write = write;

	refusing.write = true;
	expect(text.change('---\ntitle: A\npinned: false\n---\nNewer.\n')).toBe(true);
	await text.save();
	expect(text.failed).toBe(true);
	expect(body.change('Older again.\n')).toBe(false);
	expect(edits.field('notes', 'a', 'title').change('Other')).toBe(false);
	refusing.write = false;
	await edits.settled();
	expect((await stored(folder, 'a'))?.body).toBe('Newer.\n');
});

test("a file's text typed into a file deleted elsewhere is let go and offered once, as soon as a read without it lands", async () => {
	const { folder, context, edits, failures } = await setup({
		refusable: true,
	});
	expectOk(await folder.write('note.txt', null, 'one\n'));
	const options = context.queries.files.text.queryOptions('note.txt');
	const stop = new QueryObserver(context.queryClient, options).subscribe(
		() => {},
	);
	cleanup.push(stop);
	await context.queryClient.fetchQuery(options);
	const text = edits.text('note.txt');
	refusing.write = true;
	text.change('two\n');
	await text.save();
	expect(edits.unsaved()).toBe(true);
	const before = failures.length;

	refusing.write = false;
	expectOk(await folder.write('note.txt', 'one\n', null));
	await context.queryClient.invalidateQueries({
		queryKey: context.queries.files.text.queryKey('note.txt'),
	});
	await until(() => failures.length > before, 'the offer');
	expect(failures.slice(before)).toHaveLength(1);
	expect(failures.at(-1)).toMatchObject({
		path: 'note.txt',
		unsaved: 'two\n',
		error: { name: 'NotFound' },
	});
	expect(text.typed).toBe(undefined);
	expect(edits.unsaved()).toBe(false);
	expect(edits.busy).toBe(false);
});

test('a field save whose write throws ends saving and is reported; close still completes', async () => {
	const { folder, context, edits, failures } = await setup();
	const set = folder.tables.notes.set;
	folder.tables.notes.set = (async () => {
		throw new Error('host went away');
	}) as unknown as typeof set;
	const title = edits.field('notes', 'a', 'title');
	title.change('Typed');
	await title.save();
	expect(title.saving).toBe(false);
	expect(title.typed).toBe('Typed');
	expect(failures.at(-1)).toMatchObject({
		path: 'notes/a.md',
		unsaved: 'Typed',
		error: { name: 'Io' },
	});
	await context.close();
	folder.tables.notes.set = set;
});

test('Discard from an older notice lets go of typing made since and answers it, for a body, a field, and a save still running', async () => {
	const { folder, edits, failures } = await setup();
	const write = folder.tables.notes.write;
	let gate: PromiseWithResolvers<void> | undefined;
	folder.tables.notes.write = (async () => {
		await gate?.promise;
		return { data: null, error: { name: 'Io', message: 'disk full' } };
	}) as unknown as typeof write;
	const body = edits.body('notes', 'a');
	body.change('One.\nA\n');
	await body.save();
	const older = failures.at(-1);
	expect(older?.unsaved).toBe('One.\nA\n');
	body.change('One.\nA\nB typed after\n');
	expect(older?.discard?.()).toBe('One.\nA\nB typed after\n');
	expect(body.typed).toBe(undefined);

	// A newer save runs when the older notice's Discard is clicked: the
	// discard answers its text, and its failure afterwards tells nothing.
	body.change('One.\nC\n');
	await body.save();
	const second = failures.at(-1);
	body.change('One.\nC\nD\n');
	gate = Promise.withResolvers<void>();
	const running = body.save();
	await until(() => body.saving, 'the newer save to run');
	const told = failures.length;
	expect(second?.discard?.()).toBe('One.\nC\nD\n');
	gate.resolve();
	await running;
	expect(failures).toHaveLength(told);
	expect(edits.unsaved()).toBe(false);
	folder.tables.notes.write = write;

	const set = folder.tables.notes.set;
	folder.tables.notes.set = (async () => ({
		data: null,
		error: { name: 'Io', message: 'disk full' },
	})) as unknown as typeof set;
	const title = edits.field('notes', 'a', 'title');
	title.change('Old');
	await title.save();
	const fieldNotice = failures.at(-1);
	title.change('Old plus newer');
	expect(fieldNotice?.discard?.()).toBe('Old plus newer');
	expect(title.typed).toBe(undefined);
	folder.tables.notes.set = set;
});

test('typing a settle cannot even send, as a body whose row stopped reading, is told with Discard, and discarding frees the file', async () => {
	const { folder, context, edits, failures } = await setup();
	const write = folder.tables.notes.write;
	folder.tables.notes.write = (async () => ({
		data: null,
		error: { name: 'Io', message: 'disk full' },
	})) as unknown as typeof write;
	const body = edits.body('notes', 'a');
	body.change('Mine.\n');
	await body.save();
	folder.tables.notes.write = write;
	// Another program leaves the file unreadable as a row.
	expectOk(
		await folder.write(
			'notes/a.md',
			'---\ntitle: A\npinned: false\n---\nOne.\n',
			'---\ntitle: A\npinned: maybe\n---\nOne.\n',
		),
	);
	await context.queryClient.refetchQueries({
		queryKey: context.queries.notes.list.queryKey(),
	});
	const before = failures.length;

	expect((await edits.saveVersion()).error?.name).toBe('NotStarted');
	expect(failures).toHaveLength(before + 1);
	const told = failures.at(-1);
	expect(told).toMatchObject({ path: 'notes/a.md', unsaved: 'Mine.\n' });
	expect(told?.discard?.()).toBe('Mine.\n');

	const opened = await context.queryClient.fetchQuery({
		...context.queries.files.text.queryOptions('notes/a.md'),
		staleTime: 0,
	});
	const text = edits.text('notes/a.md');
	expect(
		text.change((opened as { text: string }).text.replace('maybe', 'false')),
	).toBe(true);
	await text.save();
	expect(expectOk(await edits.saveVersion()).status).toBe('committed');
	expect(await stored(folder, 'a')).toEqual({
		fields: { title: 'A', pinned: false },
		body: 'One.\n',
	});
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
