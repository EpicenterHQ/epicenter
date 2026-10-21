/**
 * Durable Capture Compositions
 *
 * Exercises real Folder storage, including reopening the same IndexedDB
 * profile. Draft bodies remain exact raw writing until same-file promotion;
 * creation, autosave, promotion and discard failures never silently lose it.
 */
import 'fake-indexeddb/auto';
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { captureTables, composeBody } from '@epicenter/capture';
import { openFolder } from '@epicenter/folder/browser';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CapturesHarness,
	openCaptures,
} from './local-folder.test-support.js';

const { createFolderContext } = await import('@epicenter/svelte/folder');
const { createCaptures, describeFailure, timelineOf } = await import(
	'./captures.svelte.ts'
);
const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup() {
	const harness = await openCaptures({}, { saveAfterMs: 60_000 });
	cleanup.push(() => harness.close());
	return harness;
}

async function compose(t: CapturesHarness, text: string) {
	const { stem } = expectOk(await t.captures.create());
	const edit = t.folder.tables.captures.edit(stem);
	expectOk(await edit.read());
	expectOk(edit.change({ body: text }));
	return { stem, path: `captures/${stem}.md`, edit };
}

/** A new context and collection over the existing profile, without resetting IndexedDB. */
async function restart(t: CapturesHarness) {
	await t.context.close();
	const folder = expectOk(await openFolder({ tables: captureTables }));
	const context = createFolderContext(folder);
	const captures = createCaptures(context);
	cleanup.push(() => context.close());
	await context.queryClient.fetchQuery(captures.rowsQuery());
	return { folder, captures };
}

test('restart discovers every draft and recovers ambiguous Markdown, spaces and CRLF exactly', async () => {
	const t = await setup();
	const texts = [
		'  \n\n',
		'```ts\nunfinished\n',
		'## Thoughts\n\n- my own list\n',
		'first\r\nsecond\r\n\r\n',
	];
	const drafts = [];
	for (const text of texts) drafts.push({ ...(await compose(t, text)), text });
	// Close flushes even before the debounce; no form text is copied to the new context.
	const resumed = await restart(t);
	const reading = timelineOf(
		expectOk(await resumed.folder.tables.captures.list()),
	);
	expect(reading.rows).toEqual([]);
	expect(reading.repairs).toEqual([]);
	expect(reading.drafts).toHaveLength(texts.length);
	for (const { stem, text } of drafts) {
		const row = expectOk(await resumed.folder.tables.captures.get(stem));
		expect(row?.body).toBe(text);
		expect(row?.fields.draft).toBe(true);
		resumed.captures.open(stem, 'capture');
		expect(resumed.captures.opened).toEqual({ stem, mode: 'capture' });
	}
});

test('Add preserves the existing composeBody behavior for arbitrary pasted Markdown', async () => {
	const t = await setup();
	for (const text of [
		'Hello\nworld',
		'```ts\nunfinished',
		'## Thoughts\n\n- original',
		'## Thoughts\n\n- original\n\n```',
	]) {
		const { stem } = await compose(t, text);
		expectOk(await t.captures.add(stem));
		const row = expectOk(await t.folder.tables.captures.get(stem));
		expect(row?.body).toBe(composeBody(text).body);
		expect(row?.fields.draft).toBeUndefined();
	}
	expect(expectOk(await t.folder.tables.captures.list())).toHaveLength(4);
});

test('a failed initial creation opens no composer and leaves no record', async () => {
	const t = await setup();
	const restore = t.failSaves();
	expect(expectErr(await t.captures.create()).name).toBe('StorageFailed');
	expect(t.captures.opened).toBeUndefined();
	restore();
	expect(expectOk(await t.folder.tables.captures.list())).toEqual([]);
});

test('failed autosave and blocked discard keep raw input until explicit retry; successful discard survives restart', async () => {
	const t = await setup();
	const { stem, edit, path } = await compose(t, 'unfinished ```\n');
	const restore = t.failSaves();
	await edit.save();
	expect(edit.getPending()?.error?.name).toBe('StorageFailed');
	expect(edit.getRow()?.body).toBe('unfinished ```\n');
	expect(t.captures.failures.map((failure) => failure.path)).toContain(path);
	const refused = expectErr(
		await t.captures.delete(t.captures.deletionFor(stem)),
	);
	expect(describeFailure(refused)).toContain('Use Save again');
	expect(edit.getRow()?.body).toBe('unfinished ```\n');
	restore();
	await edit.retry();
	expect(edit.getPending()).toBeUndefined();
	expect(
		expectOk(await t.captures.delete(t.captures.deletionFor(stem))).deleted,
	).toBe(true);
	const resumed = await restart(t);
	expect(expectOk(await resumed.folder.tables.captures.list())).toEqual([]);
});

test('a failed promotion leaves the stored and editable raw draft; retry appends Thoughts once', async () => {
	const t = await setup();
	const { stem, edit } = await compose(t, 'Still composing\n');
	await edit.save();
	const restore = t.failSaves();
	expect(expectErr(await t.captures.add(stem)).name).toBe('StorageFailed');
	expect(edit.getPending()).toBeUndefined();
	expect(edit.getRow()?.body).toBe('Still composing\n');
	expect(edit.getRow()?.fields.draft).toBe(true);
	restore();
	const resumed = await restart(t);
	expect(expectOk(await resumed.folder.tables.captures.get(stem))?.body).toBe(
		'Still composing\n',
	);
	expectOk(await resumed.captures.add(stem));
	// Another tab or a lost receipt can leave an already-promoted file on retry.
	expectOk(await resumed.captures.add(stem));
	const row = expectOk(await resumed.folder.tables.captures.get(stem));
	expect(row?.body).toBe(composeBody('Still composing\n').body);
	expect(row?.body.match(/^## Thoughts$/gm)).toHaveLength(1);
});

test('a failed delete leaves a saved composition discoverable and retry removes it', async () => {
	const t = await setup();
	const { stem, edit } = await compose(t, 'Keep me if discard fails');
	await edit.save();
	const restore = t.failSaves();
	expectErr(await t.captures.delete(t.captures.deletionFor(stem)));
	expect(t.captures.opened?.stem).toBe(stem);
	restore();
	const resumed = await restart(t);
	expect(
		timelineOf(
			expectOk(await resumed.folder.tables.captures.list()),
		).drafts.map((row) => row.stem),
	).toEqual([stem]);
	expect(
		expectOk(await resumed.captures.delete(resumed.captures.deletionFor(stem)))
			.deleted,
	).toBe(true);
});

test('accepted Add finishes when close begins and new input is refused', async () => {
	const t = await setup();
	const { stem, edit, path } = await compose(t, 'Accepted before close');
	const adding = t.captures.add(stem);
	expectErr(edit.change({ body: 'Late input' }));
	const closing = t.context.close();
	expectOk(await adding);
	expect(await closing).toEqual([]);
	expect(await t.text(path)).toContain(
		composeBody('Accepted before close').body,
	);
	expect(await t.text(path)).not.toContain('draft:');
});

test('promotion rereads schema and refuses a draft another writer made invalid', async () => {
	const t = await setup();
	const { stem, edit, path } = await compose(t, 'Raw text');
	await edit.save();
	await t.writeElsewhere(
		path,
		'---\ncapturedAt: broken\ndraft: true\n---\nRaw text',
	);
	expect(expectErr(await t.captures.add(stem)).name).toBe('NotStarted');
	expect(await t.text(path)).toContain('draft: true');
});

test('another tab promotion keeps already accepted raw edits through the ordinary merge', async () => {
	const t = await setup();
	const { stem, edit, path } = await compose(t, 'Before');
	await edit.save();
	const other = expectOk(await openFolder({ tables: captureTables }));
	const otherContext = createFolderContext(other);
	cleanup.push(() => otherContext.close());
	const otherCaptures = createCaptures(otherContext);
	expectOk(edit.change({ body: 'Typed here' }));
	expectOk(await otherCaptures.add(stem));
	await edit.read();
	await edit.save();
	const text = await t.text(path);
	expect(text).toContain('Typed here');
	expect(text).toContain('## Thoughts');
	expect(text).not.toContain('draft:');
});
