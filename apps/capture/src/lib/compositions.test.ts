/**
 * Saved Draft Composition Tests
 *
 * Checks that old draft files remain raw until Add, then finish once from
 * the saved mirror body. Failed operations leave the stored draft intact.
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { captureBody, composeBody } from '@epicenter/capture';
import { expectErr, expectOk } from 'wellcrafted/testing';
import {
	type CapturesHarness,
	openCaptures,
} from './local-folder.test-support.js';

const AT = '2026-10-01T10:30:00Z';
const PATH = 'captures/one.md';
const draftFile = (raw: string) =>
	`---\ncapturedAt: ${AT}\ndraft: true\n---\n${raw}`;
const harnesses: CapturesHarness[] = [];
afterEach(async () => {
	for (const harness of harnesses.splice(0)) await harness.close();
});
async function open(raw: string) {
	const harness = await openCaptures({ [PATH]: draftFile(raw) });
	harnesses.push(harness);
	return harness;
}

test('a saved draft stays raw and is listed apart', async () => {
	const raw = 'Writing\n\n## Thoughts\n\n- not yet organized\n';
	const h = await open(raw);
	expect(h.captures.timeline.rows).toEqual([]);
	expect(h.captures.timeline.drafts[0]?.preview).toContain('Writing');
	expect(h.cached('one')?.body).toBe(raw);
});

test('Add finishes the same file once and opens its capture view', async () => {
	const h = await open('Writing');
	expectOk(await h.captures.finishDraft('one'));
	expect(h.captures.opened).toEqual({
		stem: 'one',
		mode: 'capture',
		focus: 'new-thought',
	});
	const row = h.cached('one');
	if (row?.issues !== null) throw new Error('finished row must read');
	expect(row.fields.draft).toBeUndefined();
	expect(row.body).toBe(composeBody('Writing').body);
	expectOk(await h.captures.finishDraft('one'));
	expect(h.cached('one')?.body).toBe(row.body);
	expect(h.captures.timeline.drafts).toEqual([]);
});

test('blank draft refuses Add without changing the file', async () => {
	const h = await open('   ');
	expect(expectErr(await h.captures.finishDraft('one')).name).toBe('Refused');
	expect(h.text(PATH)).toBe(draftFile('   '));
});

test('failed Add keeps draft on disk and a retry composes once', async () => {
	const h = await open('Writing');
	const restore = h.failSaves(PATH);
	expect(expectErr(await h.captures.finishDraft('one')).name).toBe(
		'StorageFailed',
	);
	expect(h.text(PATH)).toBe(draftFile('Writing'));
	restore();
	expectOk(await h.captures.finishDraft('one'));
	const row = h.cached('one');
	if (row?.issues !== null) throw new Error('finished row must read');
	expect(expectOk(captureBody.decode(row.body)).text).toBe('Writing');
	expect(row.body.match(/## Thoughts/g)?.length).toBe(1);
});

test('leaving during a draft finish keeps the timeline open', async () => {
	const h = await open('Writing');
	await h.captures.open('one', 'text');
	let release = () => {};
	h.host.control.putGate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const finishing = h.captures.finishDraft('one');
	h.captures.leave();
	release();
	expectOk(await finishing);
	expect(h.captures.opened).toBeUndefined();
	expect(h.cached('one')?.issues).toBeNull();
	expect(h.captures.timeline.drafts).toEqual([]);
});

test('failed discard keeps the saved draft and retry deletes it', async () => {
	const h = await open('Writing');
	const deletion = h.captures.deletionFor('one');
	const restore = h.failSaves(PATH);
	expect(expectErr(await h.captures.delete(deletion)).name).toBe(
		'StorageFailed',
	);
	expect(h.text(PATH)).toBe(draftFile('Writing'));
	restore();
	expectOk(await h.captures.delete(deletion));
	expect(h.text(PATH)).toBeUndefined();
});

test('another writer finishing a draft is recognized before a stale Add', async () => {
	const h = await open('Writing');
	h.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n${composeBody('Elsewhere').body}`,
	);
	h.folder.checkpoint();
	await Bun.sleep(20);
	expectOk(await h.captures.finishDraft('one'));
	expect(h.cached('one')?.body).toBe(composeBody('Elsewhere').body);
});
