/**
 * Capture Store Tests
 *
 * The store over real device clients (`capture-device.test-support.ts`):
 * Add, the timeline, edits through the one list, navigation, and deletion.
 *
 * Key behaviors:
 * - Add writes one finished capture at `captures/<timeId>.md`, in house
 *   style, records it to upload, and opens it at Add a thought
 * - Signed in, Add still writes to this browser first (`createOn: 'device'`)
 * - Blank or failed Add leaves no file
 * - The timeline orders by the instant captured and lists files to repair
 *   and files that are not text
 * - A body edit keeps unknown front matter keys and writes house style
 * - Another writer's change reaches the timeline
 * - `locateThought` finds a thought's lines in the note's text
 * - A delete removes the file and closes it; a failed one keeps it
 */
import '../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { composeBody } from '@epicenter/capture';
import { outboxOf } from '@epicenter/folder/node';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CapturesHarness,
	openCaptures,
	until,
} from './capture-device.test-support.js';

const { locateThought } = await import('./capture-actions.svelte.ts');
const { captureText } = await import('./captures.svelte.ts');

const harnesses: CapturesHarness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close();
});
async function open(...args: Parameters<typeof openCaptures>) {
	const harness = await openCaptures(...args);
	harnesses.push(harness);
	return harness;
}

const AT = '2026-10-01T10:30:00+08:00';
const PATH = 'captures/one.md';
const HAND = `---\ncapturedAt: ${AT}\ncustom: kept\n---\n\nText\n\n## Thoughts\n\n- first\n`;

test('Add writes one finished capture in house style, records it to upload, and opens Add a thought', async () => {
	const h = await open();
	const { id } = expectOk(await h.captures.create('Hello\nworld'));
	expect(id).toMatch(
		/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-z]{8}$/,
	);
	expect(h.captures.opened).toEqual({
		id,
		mode: 'capture',
		focus: 'new-thought',
	});
	const note = h.list.get({ id });
	expect(note?.body).toBe(composeBody('Hello\nworld').body);
	expect(await h.text(`captures/${id}.md`)).toBe(
		`---\ncapturedAt: "${note?.capturedAt}"\n---\n${composeBody('Hello\nworld').body}`,
	);
	expect(h.captures.timeline.rows[0]).toMatchObject({ id, where: 'device' });
	const queued = expectOk(await outboxOf(h.device).list()).items;
	expect(queued.map(({ paths }) => Object.keys(paths))).toEqual([
		[`captures/${id}.md`],
	]);
});

test('signed in, Add writes to this browser first, marked not uploaded yet', async () => {
	const h = await open({}, { repository: { [PATH]: HAND } });
	expect(h.captures.uploads).toBe(true);
	const { id } = expectOk(await h.captures.create('Quick'));
	await until(() => h.captures.timeline.rows.length === 2);
	expect(h.captures.timeline.rows.map(({ id, where }) => [id, where])).toEqual([
		[id, 'device'],
		['one', 'repository'],
	]);
	expect(await h.repositoryText(`captures/${id}.md`)).toBeNull();
});

test('blank and failed Add leave no file and keep the timeline empty', async () => {
	const h = await open();
	expect(expectErr(await h.captures.create(' ')).name).toBe('Refused');
	const restore = h.failWrites();
	expect(expectErr(await h.captures.create('Keep me')).name).toBe(
		'Unavailable',
	);
	restore();
	expect(h.captures.timeline.rows).toEqual([]);
	expect(h.captures.opened).toBeUndefined();
	expect(expectOk(await outboxOf(h.device).list()).items).toEqual([]);
});

test('timeline orders captured instants and lists files to repair and files that are not text', async () => {
	const h = await open({
		[PATH]: HAND,
		'captures/two.md': '---\ncapturedAt: 2026-10-01T04:00:00Z\n---\nLater\n',
		'captures/broken.md': '---\ncapturedAt: nope\n---\nBody\n',
		'captures/twice.md': `---\ncapturedAt: ${AT}\n---\n## Thoughts\n\n- a\n\n## Thoughts\n`,
		'captures/binary.md': new Uint8Array([0xff]),
	});
	// 04:00Z is later than 10:30+08:00 (02:30Z).
	expect(h.captures.timeline.rows.map((row) => row.id)).toEqual(['two', 'one']);
	expect(h.captures.timeline.repairs.map((file) => file.path)).toEqual([
		'captures/broken.md',
		'captures/twice.md',
	]);
	expect(h.captures.timeline.repairs[0]?.problem).toContain('capturedAt');
	expect(h.captures.timeline.notText).toEqual([
		{ id: 'binary', path: 'captures/binary.md' },
	]);
	// Neither opens as a capture.
	h.captures.open('twice', 'capture');
	expect(h.captures.opened).toEqual({
		id: 'twice',
		mode: 'text',
		focus: undefined,
	});
});

test('a body edit keeps unknown front matter keys and writes house style', async () => {
	const original = HAND.replace(
		'custom: kept',
		'zeta: last\n# comment\ncustom: kept\nalpha: first',
	);
	const h = await open({ [PATH]: original });
	expectOk(
		await h.list.update({ id: 'one' }, { body: composeBody('Changed').body }),
	);
	expect(await h.text(PATH)).toBe(
		`---\ncapturedAt: "${AT}"\nalpha: first\ncustom: kept\nzeta: last\n---\n${composeBody('Changed').body}`,
	);
});

test('opening another capture while Add saves keeps that capture open', async () => {
	const h = await open({ [PATH]: HAND });
	const release = h.holdWrites();
	const adding = h.captures.create('New capture');
	h.captures.open('one', 'capture');
	release();
	expectOk(await adding);
	expect(h.captures.opened?.id).toBe('one');
});

test('another writer’s change reaches the timeline', async () => {
	const h = await open({ [PATH]: HAND });
	await h.writeElsewhere(PATH, HAND.replace('Text', 'Elsewhere'));
	await until(
		() => h.captures.timeline.rows[0]?.preview.includes('Elsewhere') ?? false,
	);
});

test('locateThought refuses a stale list and finds the thought’s lines in the note’s text', async () => {
	const h = await open({ [PATH]: HAND });
	const note = h.list.get({ id: 'one' });
	if (note === undefined) throw new Error('fixture must read');
	const text = expectOk(captureText(note));
	expect(locateThought(text, note.body, 0, ['other'])).toBeUndefined();
	const range = locateThought(text, note.body, 0, ['first']);
	expect(range).toBeDefined();
	expect(text.slice(range?.start, range?.end)).toBe('- first');
});

test('delete removes the file and closes it, and a later update cannot recreate it', async () => {
	const h = await open({ [PATH]: HAND });
	h.captures.open('one', 'capture');
	expectOk(await h.captures.delete(h.captures.deletionFor('one')));
	expect(h.captures.opened).toBeUndefined();
	expect(h.list.get({ id: 'one' })).toBeUndefined();
	expect(
		expectErr(await h.list.update({ id: 'one' }, { body: 'later' })).name,
	).toBe('NotFound');
	expect(await h.text(PATH)).toBeNull();
});

test('a failed delete keeps the capture and a retry deletes it', async () => {
	const h = await open({ [PATH]: HAND });
	const deletion = h.captures.deletionFor('one');
	expect(deletion.title).toBe('Text');
	const restore = h.failWrites();
	expect(expectErr(await h.captures.delete(deletion)).name).toBe('Unavailable');
	expect(await h.text(PATH)).toBe(HAND);
	restore();
	expectOk(await h.captures.delete(deletion));
	expect(await h.text(PATH)).toBeNull();
});
