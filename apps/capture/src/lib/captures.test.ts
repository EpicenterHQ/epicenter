/**
 * Capture Store Tests
 *
 * Exercises capture creation, mirror-backed timeline, thought composition,
 * mode settling, repair, and deletion on a real folder mirror.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { captureBody, composeBody } from '@epicenter/capture';
import { readRow } from '@epicenter/folder/next';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CapturesHarness,
	openCaptures,
	until,
} from './local-folder.test-support.js';

const { createCaptureActions, locateThought } = await import(
	'./capture-actions.svelte.ts'
);
const { timelineOf } = await import('./captures.svelte.ts');
const harnesses: CapturesHarness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close();
});
async function open(
	files: Record<string, string | Uint8Array> = {},
	throttleMs = 20,
) {
	const harness = await openCaptures(files, { throttleMs });
	harnesses.push(harness);
	return harness;
}

const AT = '2026-10-01T10:30:00+08:00';
const PATH = 'captures/one.md';
const HAND = `---\ncapturedAt: ${AT}\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n`;
function bodyDraft(harness: CapturesHarness, stem = 'one') {
	const row = () => harness.folder.tables.captures.row(stem);
	let typed: string | undefined;
	return {
		get text() {
			const saved = row();
			return typed ?? (saved?.issues === null ? saved.body : '');
		},
		set(body: string) {
			typed = body;
			void harness.captures.track(
				harness.folder.tables.captures.update(stem, { body }),
			);
		},
	};
}

test('Add writes one finished capture and opens Add a thought', async () => {
	const h = await open();
	const { stem } = expectOk(await h.captures.create('Hello\nworld'));
	expect(stem).toMatch(/^\d{8}-\d{6}-[0-9a-z]{5}$/);
	expect(h.captures.opened).toEqual({
		stem,
		mode: 'capture',
		focus: 'new-thought',
	});
	const row = h.cached(stem);
	expect(row?.issues).toBeNull();
	if (row?.issues !== null)
		expect(row?.body).toBe(composeBody('Hello\nworld').body);
	expect(h.captures.timeline.rows[0]?.stem).toBe(stem);
});

test('blank and failed Add leave no file; failed Add keeps no mirror row', async () => {
	const h = await open();
	expect(expectErr(await h.captures.create(' ')).name).toBe('Refused');
	const restore = h.failSaves('captures/one.md');
	const failure = h.host.control.failPut.get('captures/one.md');
	if (failure === undefined) throw new Error('Failure was not installed');
	// The generated stem is unknown; fail every put through the host callback.
	h.host.control.beforePut = (path) =>
		h.host.control.failPut.set(path, failure);
	expect(expectErr(await h.captures.create('Keep me')).name).toBe(
		'StorageFailed',
	);
	expect(h.captures.timeline.rows).toEqual([]);
	expect(h.host.log.puts.length).toBe(1);
	restore();
	h.host.control.beforePut = undefined;
});

test('timeline orders captured instants and lists repair and nontext rows', async () => {
	const h = await open({
		'captures/one.md': HAND,
		'captures/two.md': '---\ncapturedAt: 2026-10-01T04:00:00Z\n---\nLater\n',
		'captures/broken.md': '---\ncapturedAt: nope\n---\nBody\n',
		'captures/binary.md': new Uint8Array([0xff]),
	});
	expect(h.captures.timeline.rows.map((row) => row.stem)).toEqual([
		'two',
		'one',
	]);
	expect(h.captures.timeline.repairs.map((row) => row.stem)).toEqual([
		'broken',
	]);
	expect(timelineOf(h.rows()).unreadable).toEqual([
		{
			path: 'captures/binary.md',
			message: 'The file is not valid UTF-8.',
			retry: false,
		},
	]);
});

test('body updates canonicalize frontmatter while keeping unknown fields', async () => {
	const original = HAND.replace(
		'custom: kept',
		'zeta: last\n# comment\ncustom: kept\nalpha: first',
	);
	const h = await open({ [PATH]: original });
	expectOk(
		await h.folder.tables.captures.update('one', {
			body: composeBody('Changed').body,
		}),
	);
	expect(h.text(PATH)).toBe(
		`---\ncapturedAt: "${AT}"\nalpha: first\ncustom: kept\nzeta: last\n---\n${composeBody('Changed').body}`,
	);
});

test('thought added under the throttle keeps text typed moments before it', async () => {
	const h = await open({ [PATH]: HAND }, 1000);
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const body = bodyDraft(h);
	const actions = createCaptureActions(body);
	actions.inputText('Typed just now');
	await until(() => h.host.log.puts.length > 0);
	expect(actions.addThought('second')).toBe(true);
	release();
	await h.captures.settle();
	const row = h.cached('one');
	expect(row?.issues).toBeNull();
	if (row?.issues === null) {
		const value = expectOk(captureBody.decode(row.body));
		expect(value.text).toBe('Typed just now');
		expect(value.thoughts).toEqual(['first', 'second']);
	}
});

test('mode switch waits for the last save and starts from the saved file', async () => {
	const h = await open({ [PATH]: HAND });
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const body = bodyDraft(h);
	createCaptureActions(body).inputText('Pending');
	const switching = h.captures.open('one', 'text');
	await Bun.sleep(10);
	expect(h.captures.opened).toBeUndefined();
	release();
	await switching;
	expect(h.captures.opened?.mode).toBe('text');
	expect(h.text(PATH)).toContain('Pending');
});

test('a failed body write leaves the saved row unchanged and still switches modes', async () => {
	const h = await open({ [PATH]: HAND });
	h.failSaves(PATH);
	const body = bodyDraft(h);
	createCaptureActions(body).inputText('Not landed');
	await h.captures.open('one', 'text');
	expect(h.captures.opened?.mode).toBe('text');
	expect(h.text(PATH)).toBe(HAND);
	expect(h.failures[0]?.text).toContain('Not landed');
	expect(h.captures.saveLabel).toBe('Saved');
});

test('another writer appears in the mirror after a hint', async () => {
	const h = await open({ [PATH]: HAND });
	h.writeElsewhere(PATH, HAND.replace('Text', 'Elsewhere'));
	await until(() => h.cached('one')?.body?.includes('Elsewhere') === true);
	expect(h.captures.timeline.rows[0]?.preview).toContain('Elsewhere');
});

test('locateThought refuses a stale list and finds the saved thought lines', async () => {
	const h = await open({ [PATH]: HAND });
	const row = h.cached('one');
	if (row?.issues !== null) throw new Error('fixture must read');
	expect(locateThought(HAND, row.body, 0, ['other'])).toBeUndefined();
	const range = locateThought(HAND, row.body, 0, ['first']);
	expect(range).toBeDefined();
	expect(HAND.slice(range!.start, range!.end)).toContain('- first');
});

test('repair checks the typed text before it saves', async () => {
	const invalid = '---\ncapturedAt: nope\n---\nBody\n';
	const h = await open({ [PATH]: invalid });
	const fixed = invalid.replace('nope', AT);
	expect(
		readRow(
			invalid,
			(await import('@epicenter/capture')).captureTables.captures,
		).issues,
	).not.toBeNull();
	expect(
		readRow(fixed, (await import('@epicenter/capture')).captureTables.captures)
			.issues,
	).toBeNull();
	expect(h.text(PATH)).toBe(invalid);
});

test('delete removes the mirror row and typing later cannot recreate it with update', async () => {
	const h = await open({ [PATH]: HAND });
	await h.captures.open('one', 'capture');
	expectOk(await h.captures.delete(h.captures.deletionFor('one')));
	expect(h.captures.opened).toBeUndefined();
	expect(h.cached('one')).toBeUndefined();
	expect(
		expectErr(await h.folder.tables.captures.update('one', { body: 'later' }))
			.name,
	).toBe('NothingToUpdate');
	expect(h.text(PATH)).toBeUndefined();
});
