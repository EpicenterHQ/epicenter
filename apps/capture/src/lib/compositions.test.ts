/**
 * Drafts From an Earlier Version
 *
 * An earlier version saved New capture's writing as a `draft: true` file
 * before Add. Those files are real documents: they stay listed apart, open
 * with their raw writing exactly, autosave through the folder's edit, and
 * finish as the same file. Exercises real Folder storage, including reopening
 * the same IndexedDB profile.
 *
 * Key behaviors:
 * - Drafts are listed apart, and their raw writing reads back exactly
 * - Finishing composes the raw writing once, keeping the file's identity
 * - Failed autosave, finish, and discard never silently lose raw writing
 * - Finishing, closing, and another tab's change keep the ordinary Folder rules
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
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	for (const close of cleanup.splice(0).reverse()) await close();
});

const AT = '2026-10-01T10:30:00Z';
/** A draft file as an earlier version saved it: `raw` is its whole body. */
const draftFile = (raw: string) =>
	`---\ncapturedAt: ${AT}\ndraft: true\n---\n${raw}`;

/** A profile holding one draft per stem, its raw writing as given. */
async function setup(drafts: Record<string, string>) {
	const harness = await openCaptures(
		Object.fromEntries(
			Object.entries(drafts).map(([stem, raw]) => [
				`captures/${stem}.md`,
				draftFile(raw),
			]),
		),
		{ saveAfterMs: 60_000 },
	);
	cleanup.push(() => harness.close());
	return harness;
}

/** The draft `stem`, read, with `raw` typed over it. */
async function typeInto(t: CapturesHarness, stem: string, raw: string) {
	const edit = t.folder.tables.captures.edit(stem);
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: raw }));
	return { stem, path: `captures/${stem}.md`, edit };
}

/** A new context and collection over the existing profile, without resetting IndexedDB. */
async function restart(t: CapturesHarness) {
	t.context.close();
	const folder = expectOk(await openFolder({ tables: captureTables }));
	const context = createFolderContext(folder);
	const captures = createCaptures(context);
	cleanup.push(() => context.close());
	await context.queryClient.fetchQuery(captures.rowsQuery());
	return { folder, captures };
}

test('drafts are listed apart and open with ambiguous Markdown, spaces and CRLF exactly', async () => {
	const texts = {
		blank: '  \n\n',
		fence: '```ts\nunfinished\n',
		heading: '## Thoughts\n\n- my own list\n',
		crlf: 'first\r\nsecond\r\n\r\n',
	};
	const t = await setup(texts);
	const reading = timelineOf(t.rows());
	expect(reading.rows).toEqual([]);
	expect(reading.repairs).toEqual([]);
	expect(reading.drafts.map((row) => row.stem).sort()).toEqual(
		Object.keys(texts).sort(),
	);
	for (const [stem, text] of Object.entries(texts)) {
		const row = expectOk(await t.folder.tables.captures.get(stem));
		expect(row?.body).toBe(text);
		expect(row?.fields?.draft).toBe(true);
		t.captures.open(stem, 'capture');
		expect(t.captures.opened).toEqual({ stem, mode: 'text' });
	}
});

test('finishing a draft keeps composeBody behavior for arbitrary pasted Markdown', async () => {
	const texts = {
		plain: 'Hello\nworld',
		fence: '```ts\nunfinished',
		heading: '## Thoughts\n\n- original',
		both: '## Thoughts\n\n- original\n\n```',
	};
	const t = await setup(texts);
	for (const [stem, text] of Object.entries(texts)) {
		expectOk(await t.captures.finishDraft(stem));
		const row = expectOk(await t.folder.tables.captures.get(stem));
		expect(row?.body).toBe(composeBody(text).body);
		expect(row?.fields?.draft).toBeUndefined();
	}
	expect(expectOk(await t.folder.tables.captures.list())).toHaveLength(4);
	expect(timelineOf(t.rows()).drafts).toEqual([]);
});

test('finishing composes current unsaved input and opens the same file at Add a thought', async () => {
	const t = await setup({ one: '' });
	const { edit } = await typeInto(t, 'one', 'Hello\nworld');
	expectOk(await t.captures.finishDraft('one'));
	const row = expectOk(await t.folder.tables.captures.get('one'));
	expect(row?.fields?.draft).toBeUndefined();
	expect(row?.body).toBe('\nHello\nworld\n\n## Thoughts\n');
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(t.captures.opened).toEqual({
		stem: 'one',
		mode: 'capture',
		focus: 'new-thought',
	});
	expect(expectOk(await t.folder.tables.captures.list())).toHaveLength(1);
});

test('a blank draft is refused by Add and remains', async () => {
	const t = await setup({ one: '' });
	const { edit } = await typeInto(t, 'one', '   ');
	const refusal = expectErr(await t.captures.finishDraft('one'));
	expect(refusal).toMatchObject({
		name: 'Refused',
		message: 'Write something first.',
	});
	expect(edit.getSnapshot().content?.body).toBe('   ');
	expect(edit.getSnapshot().content?.fields?.draft).toBe(true);
});

test('failed autosave keeps raw input and deletion removes it without a save requirement', async () => {
	const t = await setup({ one: '' });
	const { stem, edit, path } = await typeInto(t, 'one', 'unfinished ```\n');
	const restore = t.failSaves();
	await edit.save();
	expect(edit.getSnapshot().saveError?.name).toBe('StorageFailed');
	expect(edit.getSnapshot().content?.body).toBe('unfinished ```\n');
	expect(t.captures.failures.map((failure) => failure.path)).toContain(path);
	const refused = expectErr(
		await t.captures.delete(t.captures.deletionFor(stem)),
	);
	expect(describeFailure(refused)).toContain('storage');
	expect(edit.getSnapshot().content?.body).toBe('unfinished ```\n');
	restore();
	await edit.save();
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(await t.text(path)).toBe(draftFile('unfinished ```\n'));
	expectOk(await t.captures.delete(t.captures.deletionFor(stem)));
	const resumed = await restart(t);
	expect(expectOk(await resumed.folder.tables.captures.list())).toEqual([]);
});

test('a failed promotion retains original writing for explicit retry without appending Thoughts twice', async () => {
	const t = await setup({ one: 'Still composing\n' });
	const edit = t.folder.tables.captures.edit('one');
	expectOk(await edit.refresh());
	const restore = t.failSaves();
	expect(expectErr(await t.captures.finishDraft('one')).name).toBe(
		'StorageFailed',
	);
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(edit.getSnapshot().content?.body).toBe('Still composing\n');
	expect(edit.getSnapshot().content?.fields?.draft).toBe(true);
	expect(await t.text('captures/one.md')).toBe(draftFile('Still composing\n'));
	restore();
	expectOk(await t.captures.finishDraft('one'));
	const resumed = await restart(t);
	// Another tab or a lost receipt can leave an already-promoted file on retry.
	expectOk(await resumed.captures.finishDraft('one'));
	const row = expectOk(await resumed.folder.tables.captures.get('one'));
	expect(row?.body).toBe(composeBody('Still composing\n').body);
	expect(row?.body?.match(/^## Thoughts$/gm)).toHaveLength(1);
});

test('a failed discard leaves the draft discoverable and retry removes it', async () => {
	const t = await setup({ one: 'Keep me if discard fails' });
	t.captures.open('one', 'capture');
	const restore = t.failSaves();
	expectErr(await t.captures.delete(t.captures.deletionFor('one')));
	expect(t.captures.opened?.stem).toBe('one');
	restore();
	const resumed = await restart(t);
	expect(
		timelineOf(
			expectOk(await resumed.folder.tables.captures.list()),
		).drafts.map((row) => row.stem),
	).toEqual(['one']);
	expectOk(await resumed.captures.delete(resumed.captures.deletionFor('one')));
});

test('close may fail an admitted finish and refuses new input', async () => {
	const t = await setup({ one: '' });
	const { stem, edit, path } = await typeInto(
		t,
		'one',
		'Accepted before close',
	);
	const finishing = t.captures.finishDraft(stem);
	const closing = t.context.close();
	expectErr(edit.change({ body: 'Late input' }));
	expect(expectErr(await finishing).name).toBe('StorageFailed');
	expect(closing).toBeUndefined();
	expect(await t.text(path)).toContain('draft: true');
});

test('finishing refuses currently acquired invalid source', async () => {
	const t = await setup({ one: 'Raw text' });
	await t.writeElsewhere(
		'captures/one.md',
		'---\ncapturedAt: broken\ndraft: true\n---\nRaw text',
	);
	expectOk(await t.folder.tables.captures.edit('one').refresh());
	expect(expectErr(await t.captures.finishDraft('one')).name).toBe('Refused');
	expect(await t.text('captures/one.md')).toContain('draft: true');
});

test("another tab's finish preserves held input and a later save replaces the complete file", async () => {
	const t = await setup({ one: 'Before' });
	const edit = t.folder.tables.captures.edit('one');
	expectOk(await edit.refresh());
	const other = expectOk(await openFolder({ tables: captureTables }));
	const otherContext = createFolderContext(other);
	cleanup.push(() => otherContext.close());
	const otherCaptures = createCaptures(otherContext);
	expectOk(edit.replaceText(draftFile('Typed here')));
	const held = edit.getSnapshot().content?.text;
	expectOk(await otherCaptures.finishDraft('one'));
	const finished = await t.text('captures/one.md');
	await edit.refresh();
	expect(edit.getSnapshot().content?.text).toBe(held);
	expectOk(await edit.save());
	expect(edit.getSnapshot().saveError).toBeUndefined();
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(await t.text('captures/one.md')).toBe(held);
	expect(finished).toContain('Before');
	expect(finished).toContain('## Thoughts');
	expect(finished).not.toContain('draft:');
});
