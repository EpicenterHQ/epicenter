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
const cleanup: (() => Promise<unknown>)[] = [];
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
	expectOk(await edit.read());
	expectOk(edit.change({ body: raw }));
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
		expect(row?.fields.draft).toBe(true);
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
		expect(row?.fields.draft).toBeUndefined();
	}
	expect(expectOk(await t.folder.tables.captures.list())).toHaveLength(4);
	expect(timelineOf(t.rows()).drafts).toEqual([]);
});

test('finishing saves raw input first, then opens the same file at Add a thought', async () => {
	const t = await setup({ one: '' });
	const { edit } = await typeInto(t, 'one', 'Hello\nworld');
	expectOk(await t.captures.finishDraft('one'));
	const row = expectOk(await t.folder.tables.captures.get('one'));
	expect(row?.fields.draft).toBeUndefined();
	expect(row?.body).toBe('\nHello\nworld\n\n## Thoughts\n');
	expect(edit.getPending()).toBeUndefined();
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
	expect(refusal.message).toBe('Write something first.');
	expect(edit.getRow()?.body).toBe('   ');
	expect(edit.getRow()?.fields.draft).toBe(true);
});

test('failed autosave and blocked discard keep raw input until another save attempt; successful discard survives restart', async () => {
	const t = await setup({ one: '' });
	const { stem, edit, path } = await typeInto(t, 'one', 'unfinished ```\n');
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
	expect(await t.text(path)).toBe(draftFile('unfinished ```\n'));
	expect(
		expectOk(await t.captures.delete(t.captures.deletionFor(stem))).deleted,
	).toBe(true);
	const resumed = await restart(t);
	expect(expectOk(await resumed.folder.tables.captures.list())).toEqual([]);
});

test('a failed promotion leaves the stored and editable raw draft; retry appends Thoughts once', async () => {
	const t = await setup({ one: 'Still composing\n' });
	const edit = t.folder.tables.captures.edit('one');
	expectOk(await edit.read());
	const restore = t.failSaves();
	expect(expectErr(await t.captures.finishDraft('one')).name).toBe(
		'StorageFailed',
	);
	expect(edit.getPending()).toBeUndefined();
	expect(edit.getRow()?.body).toBe('Still composing\n');
	expect(edit.getRow()?.fields.draft).toBe(true);
	restore();
	const resumed = await restart(t);
	expect(expectOk(await resumed.folder.tables.captures.get('one'))?.body).toBe(
		'Still composing\n',
	);
	expectOk(await resumed.captures.finishDraft('one'));
	// Another tab or a lost receipt can leave an already-promoted file on retry.
	expectOk(await resumed.captures.finishDraft('one'));
	const row = expectOk(await resumed.folder.tables.captures.get('one'));
	expect(row?.body).toBe(composeBody('Still composing\n').body);
	expect(row?.body.match(/^## Thoughts$/gm)).toHaveLength(1);
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
	expect(
		expectOk(await resumed.captures.delete(resumed.captures.deletionFor('one')))
			.deleted,
	).toBe(true);
});

test('an accepted finish completes when close begins and new input is refused', async () => {
	const t = await setup({ one: '' });
	const { stem, edit, path } = await typeInto(t, 'one', 'Accepted before close');
	const finishing = t.captures.finishDraft(stem);
	expectErr(edit.change({ body: 'Late input' }));
	const closing = t.context.close();
	expectOk(await finishing);
	expect(await closing).toEqual([]);
	expect(await t.text(path)).toContain(
		composeBody('Accepted before close').body,
	);
	expect(await t.text(path)).not.toContain('draft:');
});

test('finishing rereads the schema and refuses a draft another writer made invalid', async () => {
	const t = await setup({ one: 'Raw text' });
	await t.writeElsewhere(
		'captures/one.md',
		'---\ncapturedAt: broken\ndraft: true\n---\nRaw text',
	);
	expect(expectErr(await t.captures.finishDraft('one')).name).toBe(
		'NotStarted',
	);
	expect(await t.text('captures/one.md')).toContain('draft: true');
});

test("another tab's finish keeps full-file edits already typed here through the ordinary merge", async () => {
	const t = await setup({ one: 'Before' });
	const edit = t.folder.tables.captures.edit('one');
	expectOk(await edit.read());
	const other = expectOk(await openFolder({ tables: captureTables }));
	const otherContext = createFolderContext(other);
	cleanup.push(() => otherContext.close());
	const otherCaptures = createCaptures(otherContext);
	expectOk(t.folder.files.edit('captures/one.md').change(draftFile('Typed here')));
	expectOk(await otherCaptures.finishDraft('one'));
	await edit.read();
	await edit.save();
	const text = await t.text('captures/one.md');
	expect(text).toContain('Typed here');
	expect(text).toContain('## Thoughts');
	expect(text).not.toContain('draft:');
});
