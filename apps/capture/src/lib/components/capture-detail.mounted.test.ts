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
 * - The capture text and Add a thought are shown at once and saved to the
 *   file
 * - A save that meets a change made elsewhere merges with it; the typing
 *   wins where both changed
 * - A change the folder's channel reports is shown
 * - A thought typed and not added stays visible to copy when the capture
 *   stops reading as text and thoughts
 * - A file that is not a valid capture shows its issues as text is typed,
 *   and opens as a capture once they are fixed
 * - Editing a CRLF file as text shows LF and writes CRLF back
 * - While Epicenter asks to quit, the text boxes take nothing
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
import { afterEach, expect, test } from 'bun:test';
import { flushSync, mount, unmount } from 'svelte';
import {
	blur,
	button,
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';

const { openCaptures } = await import('../browser-folder.test-support.js');
const { quiet } = await import('../query.test-support.js');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');

// A desktop-width window: `min-width` queries match, so the UI kit's modal
// renders as a dialog, as it does in the desktop app.
setWide(true);

/** The textarea or input with this id, or `null`. */
const field = (id: string) =>
	document.getElementById(id) as HTMLTextAreaElement | null;

/**
 * Dispatch the submit event a form delivers, on the form itself. A detached
 * form still delivers it to the listeners Svelte left on it.
 */
function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) throw new Error('Expected a form');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

type Harness = Awaited<ReturnType<typeof openCaptures>>;
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
});

const AT = '2026-10-04T20:49:23.041Z';
const PATH = 'captures/one.md';
const FILE = `---\ncapturedAt: ${AT}\n---\n\nText\n\n## Thoughts\n\n- first\n`;
/** FILE after a body write: the row's standard form (ADR-0576), with this body. */
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

test('a save that meets a change made elsewhere merges with it, and the typing wins where both changed', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	const theirs = `---\ncapturedAt: ${AT}\n---\n\nTheirs\n\n## Thoughts\n`;
	await harness.writeElsewhere(PATH, theirs);
	type(field('capture-text'), 'Mine');
	blur(field('capture-text'));
	await settle(harness);
	expect(harness.failures).toEqual([]);
	expect(field('capture-text')?.value).toBe('Mine');
	expect(await harness.text(PATH)).toContain('\nMine\n');
});

test('a change the folder reports is shown', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.writeElsewhere(PATH, `${FILE}- theirs\n`);
	await settle(harness);
	expect(harness.target.textContent).not.toContain('theirs');
	await harness.reportChange(PATH);
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
	await harness.reportChange(PATH);
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
	expect(button(document, 'Open as capture').disabled).toBe(true);

	const fixed = `---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`;
	type(contents, fixed);
	flushSync();
	expect(harness.target.textContent).not.toContain('Needs repair');
	blur(contents);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(fixed);
	click(document, 'Open as capture');
	// Opening from text first reads the listing again, which no view observes now.
	await until(() => harness.captures.opened?.mode === 'capture');
	await settle(harness);
	expect(harness.captures.opened).toEqual({ stem: 'one', mode: 'capture' });
	expect(field('capture-text')?.value).toBe('Repaired');
});

test('editing a CRLF file as text shows LF lines and writes CRLF back', async () => {
	const broken = '---\r\ncapturedAt: nope\r\n---\r\n\r\nBroken\r\n';
	const harness = await setup({ [PATH]: broken }, 'capture');
	const contents = harness.target.querySelector('textarea');
	expect(contents?.value).toBe(broken.replaceAll('\r\n', '\n'));

	type(contents, `---\ncapturedAt: ${AT}\n---\n\nRepaired\n`);
	blur(contents);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(
		`---\r\ncapturedAt: ${AT}\r\n---\r\n\r\nRepaired\r\n`,
	);
});
