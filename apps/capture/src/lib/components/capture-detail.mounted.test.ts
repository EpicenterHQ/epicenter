/**
 * Mounted Capture Detail Tests
 *
 * The real `CaptureDetail` and `TextDetail` components, compiled for the
 * client and mounted in jsdom inside the query client the layout supplies,
 * over the real Capture store and a real browser folder. Events are
 * dispatched on the components' own elements, as a keystroke or a press
 * would deliver them.
 *
 * Key behaviors:
 * - The capture text and Add a thought change the cache at once and are
 *   written to the file
 * - A write that meets a change made elsewhere rolls the text box back to
 *   the file and reports the text that was lost
 * - Returning to the window shows a change made elsewhere
 * - A thought typed and not added stays visible to copy when the capture
 *   stops reading as text and thoughts
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

const { openCaptures } = await import('../browser-folder.test-support.js');
const { focusManager, quiet } = await import('../query.test-support.js');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');

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

/** Open `one` as `mode` and mount the view the app shows for it. */
async function setup(files: Record<string, string>, mode: 'capture' | 'text') {
	const harness = await openCaptures(files);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	harness.captures.open('one', mode);
	const view = mount(ViewHost, {
		target,
		props: { captures: harness.captures },
	});
	cleanup.push(async () => {
		unmount(view);
		await harness.close();
	});
	await settle(harness);
	return { ...harness, target };
}

/** Let writes and reads run, then render. */
async function settle(harness: Harness) {
	await quiet(harness.captures);
	flushSync();
	await Bun.sleep(0);
	flushSync();
}

/** Wait a few turns for `ready`; the assertion after it says what was expected. */
async function until(ready: () => boolean) {
	for (let tries = 0; tries < 50 && !ready(); tries++) await Bun.sleep(1);
}

test('the capture text and Add a thought are written to the file', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(saved('Edited', '- first\n- second\n'));
	expect(field('new-thought')?.value).toBe('');
	expect(harness.target.textContent).toContain(`Saved to ${PATH}`);
	expect(harness.failures).toEqual([]);
});

test('a write that meets a change made elsewhere rolls the text box back to the file and reports the lost text', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	type(field('capture-text'), 'Mine');
	await settle(harness);
	expect(harness.failures).toMatchObject([
		{ path: PATH, error: { name: 'Conflict' } },
	]);
	expect(harness.failures[0]?.lost).toContain('\nMine\n');
	expect(field('capture-text')?.value).toBe('Theirs');
	expect(harness.target.textContent).not.toContain('first');
	expect(await harness.text(PATH)).toBe(theirs);
});

test('returning to the window shows a change made elsewhere', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.writeElsewhere(PATH, `${FILE}- theirs\n`);
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await Bun.sleep(0);
	await settle(harness);
	expect(harness.target.textContent).toContain('theirs');
});

test('a thought typed and not added stays visible to copy when the capture stops reading as text and thoughts', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), 'my pending thought');
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\n## Thoughts\n\n## Thoughts\n`,
	);
	focusManager.setFocused(false);
	focusManager.setFocused(true);
	await Bun.sleep(0);
	await settle(harness);
	expect(harness.target.textContent).toContain(
		'cannot be edited as text and thoughts',
	);
	const pending = harness.target.querySelector<HTMLTextAreaElement>(
		'[aria-label="Thought not added"]',
	);
	expect(pending?.value).toBe('my pending thought');
	expect(pending?.readOnly).toBe(true);
	expect(harness.captures.unsettled).toBe(true);
});

test('a file that is not a valid capture shows its issues as typed, and opens as a capture once fixed', async () => {
	const broken = '---\ncapturedAt: nope\n---\n\nBroken\n\n## Thoughts\n';
	const harness = await setup({ [PATH]: broken }, 'capture');
	expect(harness.captures.opened).toEqual({ stem: 'one', mode: 'text' });
	const contents = harness.target.querySelector('textarea');
	expect(contents?.value).toBe(broken);
	expect(harness.target.textContent).toContain('Line 2:');
	expect(button('Open as capture').disabled).toBe(true);

	const fixed = `---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`;
	type(contents, fixed);
	flushSync();
	expect(harness.target.textContent).not.toContain('Needs repair');
	await settle(harness);
	expect(await harness.text(PATH)).toBe(fixed);
	click(button('Open as capture'));
	// Opening from text first reads the row again, which no query tracks.
	await until(() => harness.captures.opened?.mode === 'capture');
	await settle(harness);
	expect(harness.captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(field('capture-text')?.value).toBe('Repaired');
});

test('while Epicenter asks to quit, the text boxes take nothing', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	harness.captures.departure.fence();
	flushSync();
	expect(field('capture-text')?.readOnly).toBe(true);
	type(field('capture-text'), 'refused');
	type(field('new-thought'), 'refused');
	expect(harness.captures.formOf('one').newThought).toBe('');
	harness.captures.departure.resume();
	await settle(harness);
	expect(field('capture-text')?.value).toBe('Text');
	expect(await harness.text(PATH)).toBe(FILE);
});
