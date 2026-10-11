/**
 * Mounted Capture Detail Tests
 *
 * The real `CaptureDetail` and `TextDetail` components, compiled for the
 * client and mounted in jsdom over the real Capture store and a real browser
 * folder. Events are dispatched on the components' own elements, as a
 * keystroke or a press would deliver them.
 *
 * Key behaviors:
 * - The capture text and Add a thought save through the open capture's
 *   session
 * - A change made elsewhere that does not overlap the text on screen is
 *   combined with no question
 * - Text both changed shows the review: Your edit saves the text on screen
 *   over theirs, and Saved elsewhere shows theirs in the same view
 * - A capture deleted elsewhere shows the review: Saved elsewhere leaves it
 *   deleted and closes it, and Your edit puts it back
 * - A thought typed and not added stays visible to copy when the capture
 *   resolves to a layout the form cannot show
 * - A file that is not a valid capture shows its issues as text is typed,
 *   and opens as a capture once they are fixed
 * - While Epicenter asks to quit, the text boxes take nothing
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
import { afterEach, expect, test } from 'bun:test';
import { flushSync, mount, unmount } from 'svelte';
import {
	button,
	click,
	field,
	submit,
	type,
} from '../svelte-dom.test-support.js';

const { openCapture, openCaptures, openText } = await import(
	'../browser-folder.test-support.js'
);
const { default: CaptureDetail } = await import('./CaptureDetail.svelte');
const { default: TextDetail } = await import('./TextDetail.svelte');

type Harness = Awaited<ReturnType<typeof openCaptures>>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
});

const AT = '2026-10-04T20:49:23.041Z';
const PATH = 'captures/one.md';
const FILE = `---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- first\n`;
const saved = (text: string, thoughts = '- first\n') =>
	`---\ncapturedAt: "${AT}"\n---\n\n${text}\n\n## Thoughts\n\n${thoughts}`;

/** Open `stem` as `mode` and mount its view. */
async function setup(files: Record<string, string>, mode: 'capture' | 'text') {
	const harness = await openCaptures(files);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	await harness.captures.open('one', mode);
	const item = harness.captures.opened;
	const view =
		item?.kind === 'capture'
			? mount(CaptureDetail, {
					target,
					props: { captures: harness.captures, item },
				})
			: item?.kind === 'text'
				? mount(TextDetail, {
						target,
						props: { captures: harness.captures, item },
					})
				: undefined;
	if (view === undefined) throw new Error(`opened ${item?.kind}`);
	flushSync();
	cleanup.push(async () => {
		unmount(view);
		await harness.close();
	});
	return { ...harness, target };
}

/**
 * Press `Use this` on `side` for the one part the review shows, then Apply,
 * and wait for the store to answer it. Answers what the person is told.
 */
async function apply(harness: Harness, side: 'local' | 'incoming') {
	const choices = [...document.querySelectorAll('button')].filter(
		(candidate) => candidate.textContent?.trim() === 'Use this',
	);
	// Your edit is first, then Saved elsewhere.
	const [local, incoming, ...rest] = choices;
	if (local === undefined || incoming === undefined || rest.length > 0)
		throw new Error(
			`Expected one part to choose, got ${choices.length} buttons`,
		);
	click(side === 'local' ? local : incoming);
	flushSync();
	const { captures } = harness;
	const resolve = captures.resolve;
	let answered: Promise<string | undefined> | undefined;
	captures.resolve = (session, picked) => {
		answered = resolve(session, picked);
		return answered;
	};
	try {
		click(button('Apply'));
	} finally {
		captures.resolve = resolve;
	}
	if (answered === undefined) throw new Error('Apply answered nothing');
	const told = await answered;
	await settle(harness);
	return told;
}

/** Wait for the open session's saves, then let the view update. */
async function settle(harness: Harness) {
	const item = harness.captures.opened;
	if (item?.kind === 'capture' || item?.kind === 'text')
		await item.session.settled();
	flushSync();
}

test('the capture text and Add a thought save through the open session', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(saved('Edited', '- first\n- second\n'));
	expect(field('new-thought')?.value).toBe('');
	expect(harness.target.textContent).toContain('Saved to');
});

test('a change made elsewhere that does not overlap the text on screen is combined with no question', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.writeElsewhere(PATH, `${FILE}- theirs\n`);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(harness.target.querySelector('[role="alert"]')).toBeNull();
	expect(field('capture-text')?.value).toBe('Mine');
	expect(harness.target.textContent).toContain('theirs');
	expect(await harness.text(PATH)).toBe(saved('Mine', '- first\n- theirs\n'));
	expect(harness.target.textContent).toContain('Saved to');
});

test('text both changed shows the review, and Your edit saves the text on screen over it', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.writeElsewhere(PATH, `---\ncapturedAt: ${AT}\n---\n\nTheirs\n`);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(harness.target.textContent).toContain('This changed elsewhere.');
	expect(harness.target.textContent).toContain(
		'Your edits are kept here and not saved.',
	);
	expect(() => button('Cancel')).toThrow();
	// One part: no Use all.
	expect(() => button('Use all from Your edit')).toThrow();
	expect(await apply(harness, 'local')).toBeUndefined();
	expect(await harness.text(PATH)).toBe(saved('Mine'));
	expect(harness.target.textContent).not.toContain('This changed elsewhere.');
	expect(harness.target.textContent).toContain('Saved to');
});

test('text both changed: Saved elsewhere shows theirs in the same view', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(await apply(harness, 'incoming')).toBeUndefined();
	expect(field('capture-text')?.value).toBe('Theirs');
	expect(harness.target.textContent).not.toContain('first');
	expect(await harness.text(PATH)).toBe(theirs);
});

test('a capture deleted elsewhere: Saved elsewhere leaves it deleted and closes it', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.deleteElsewhere(PATH);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(harness.target.textContent).toContain('This was deleted elsewhere.');
	expect(await apply(harness, 'incoming')).toBeUndefined();
	expect(harness.captures.opened).toBeUndefined();
	expect(await harness.text(PATH)).toBeUndefined();
});

test('a capture deleted elsewhere: Your edit puts it back from the text on screen', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.deleteElsewhere(PATH);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(await apply(harness, 'local')).toBeUndefined();
	expect(await harness.text(PATH)).toBe(saved('Mine'));
});

test('a thought typed and not added stays visible to copy when Saved elsewhere brings a layout the form cannot show', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), 'my pending thought');
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\n## Thoughts\n\n## Thoughts\n`,
	);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(await apply(harness, 'incoming')).toBeUndefined();
	expect(harness.target.textContent).toContain(
		'cannot be edited as text and thoughts',
	);
	const pending = harness.target.querySelector<HTMLTextAreaElement>(
		'[aria-label="Thought not added"]',
	);
	expect(pending?.value).toBe('my pending thought');
	expect(pending?.readOnly).toBe(true);
	expect(harness.captures.unsaved).toBe(true);
});

test('a file that is not a valid capture shows its issues as typed, and opens as a capture once fixed', async () => {
	const broken = '---\ncapturedAt: nope\n---\n\nBroken\n\n## Thoughts\n';
	const harness = await setup({ [PATH]: broken }, 'capture');
	const contents = harness.target.querySelector('textarea');
	expect(contents?.value).toBe(broken);
	expect(harness.target.textContent).toContain('Line 2:');
	expect(button('Open as capture').disabled).toBe(true);

	const fixed = `---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`;
	type(contents, fixed);
	flushSync();
	expect(harness.target.textContent).not.toContain('Needs repair');
	expect(openText(harness.captures).draft).toBe(fixed);
	click(button('Open as capture'));
	await Bun.sleep(20);
	expect(openCapture(harness.captures).form.text).toBe('Repaired');
	expect(await harness.text(PATH)).toBe(fixed);
});

test('while Epicenter asks to quit, the text boxes take nothing', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	harness.captures.departure.fence();
	flushSync();
	expect(field('capture-text')?.readOnly).toBe(true);
	type(field('capture-text'), 'refused');
	type(field('new-thought'), 'refused');
	const { form } = openCapture(harness.captures);
	expect(form.text).toBe('Text');
	expect(form.newThought).toBe('');
	harness.captures.departure.resume();
	await settle(harness);
	expect(await harness.text(PATH)).toBe(FILE);
});
