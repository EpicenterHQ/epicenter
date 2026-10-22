/**
 * Mounted Capture Detail Tests
 *
 * The real `CaptureDetail` and `TextDetail` components, compiled for the
 * client and mounted in jsdom inside the folder's query client, over the
 * real Capture store and a real local folder on an in-memory IndexedDB. A
 * second handle of the same profile stands in for another tab. Events are
 * dispatched on the components' own elements, as a keystroke or a press
 * would deliver them.
 *
 * Key behaviors:
 * - The capture text and Add a thought are shown at once and saved to the
 *   file
 * - Another tab's change preserves accepted typing until the next publication
 * - A failed save says so, keeps the edit, and Save again lands it
 * - A thought typed and not added is the view's: it writes nothing, a
 *   refusal keeps it, leaving the capture clears it, and it stays visible to
 *   copy when the capture stops reading as text and thoughts
 * - A thought's Edit as text opens the file with its lines selected, and
 *   unfinished Markdown typed there saves as typed
 * - A file that is not a valid capture shows its issues, is repaired as
 *   text, and opens as a capture once fixed
 * - Editing a CRLF file as text shows LF and writes CRLF back
 * - While the folder closes, the text boxes take nothing
 *
 * jsdom has no layout, focus, selection, or IME; these tests say what a
 * delivered event does, not that a person can type there.
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	blur,
	button,
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { isMissing } from '../local-folder.test-support.js';

const { flushSync, mount, unmount } = await import('svelte');
const { openCaptures, until } = await import('../local-folder.test-support.js');
const { createCaptureActions } = await import('../capture-actions.svelte.ts');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');

// A desktop-width window: `min-width` queries match, so the UI kit's modal
// renders as a dialog.
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
/** FILE with this text and these thoughts. */
const saved = (text: string, thoughts = '- first\n') =>
	`---\ncapturedAt: ${AT}\n---\n\n${text}\n\n## Thoughts\n\n${thoughts}`;

/** Open `one` as `mode` and mount the view the app shows for it. */
async function setup(
	files: Record<string, string>,
	mode: 'capture' | 'text',
	options?: { saveAfterMs?: number },
) {
	const harness = await openCaptures(files, options);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	await harness.captures.open('one', mode);
	const view = mount(ViewHost, {
		target,
		props: { captures: harness.captures },
	});
	cleanup.push(async () => {
		unmount(view);
		await harness.close();
	});
	// Initial acquisition belongs to the editor subscription, not TanStack.
	await until(() => {
		flushSync();
		const snapshot = harness.folder.tables.captures
			.document('one')
			.getSnapshot();
		return snapshot.content !== undefined || snapshot.loadError !== undefined;
	}, 'the initial editor acquisition');
	await settle(harness);
	return { ...harness, target };
}

/** Let saves and reads run, then render. */
async function settle(harness: Harness) {
	await harness.quiet();
	flushSync();
	await Bun.sleep(0);
	flushSync();
}

test('the capture text and Add a thought are saved to the file', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	expect(field('capture-text')?.value).toBe('Text');
	type(field('capture-text'), 'Edited');
	type(field('new-thought'), 'second');
	submit(field('new-thought')?.form);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(saved('Edited', '- first\n- second\n'));
	expect(field('new-thought')?.value).toBe('');
	expect(harness.target.textContent).toContain(`Saved to ${PATH}`);
});

test('two mounted capture views update each other and an intentional revert is saved', async () => {
	const harness = await setup({ [PATH]: saved('one\ntwo') }, 'capture', {
		saveAfterMs: 60_000,
	});
	const second = document.createElement('main');
	document.body.append(second);
	const view = mount(ViewHost, {
		target: second,
		props: { captures: harness.captures },
	});
	try {
		flushSync();
		const a =
			harness.target.querySelector<HTMLTextAreaElement>('#capture-text')!;
		const b = second.querySelector<HTMLTextAreaElement>('#capture-text')!;
		type(a, 'ONE\ntwo');
		flushSync();
		expect(b.value).toBe('ONE\ntwo');
		type(b, b.value.replace('two', 'TWO'));
		flushSync();
		expect(a.value).toBe('ONE\nTWO');
		type(a, 'one\nTWO');
		flushSync();
		expect(b.value).toBe('one\nTWO');
		await harness.folder.files.document(PATH).save();
		await settle(harness);
		expect(await harness.text(PATH)).toBe(saved('one\nTWO'));
	} finally {
		await unmount(view);
		second.remove();
	}
});

test("another tab's change preserves typing until the next whole-file publication", async () => {
	// Hold typing until the foreign change has arrived, then resolve explicitly.
	const harness = await setup({ [PATH]: FILE }, 'capture', {
		saveAfterMs: 60_000,
	});
	type(field('capture-text'), 'Mine');
	await harness.writeElsewhere(PATH, `${FILE}- theirs\n`);
	await until(
		() => harness.cached('one')?.body?.includes('theirs') ?? false,
		'the other tab’s save',
	);
	flushSync();
	// The view shows the body typed here until it is saved.
	expect(field('capture-text')?.value).toBe('Mine');
	expect(harness.target.textContent).not.toContain('theirs');

	const edit = harness.folder.files.document(PATH);
	await edit.save();
	expect(edit.getSnapshot().saveError).toBeUndefined();
	expect(await harness.text(PATH)).toBe(saved('Mine'));
	expectOk(edit.replace(saved('Mine', '- first\n- theirs\n')));
	await edit.save();
	await settle(harness);
	expect(field('capture-text')?.value).toBe('Mine');
	expect(harness.target.textContent).toContain('theirs');
	expect(await harness.text(PATH)).toBe(saved('Mine', '- first\n- theirs\n'));
});

test('a failed save says so, keeps the edit, and Save again lands it', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	const restore = harness.failSaves();
	type(field('new-thought'), 'kept');
	submit(field('new-thought')?.form);
	await until(() => {
		flushSync();
		return harness.target.querySelector('[aria-label="Not saved"]') !== null;
	}, 'the failure');
	expect(harness.target.textContent).toMatch(
		/This device's storage refused it: .*the disk is full/,
	);
	// The thought added stays on screen.
	expect(harness.target.textContent).toContain('kept');
	restore();
	expect(await harness.text(PATH)).toBe(FILE);

	click(harness.target, 'Save again');
	await settle(harness);
	expect(harness.target.querySelector('[aria-label="Not saved"]')).toBeNull();
	expect(await harness.text(PATH)).toBe(saved('Text', '- first\n- kept\n'));
});

test('failed row input stays copyable in the text view after switching and foreign deletion', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	const restore = harness.failSaves();
	type(field('capture-text'), 'Kept row input');
	blur(field('capture-text'));
	expect(harness.folder.files.document(PATH).getSnapshot().isSaving).toBe(
		false,
	);
	await harness.captures.open('one', 'text');
	flushSync();
	expect(harness.folder.files.document(PATH).getSnapshot().isSaving).toBe(
		false,
	);
	await until(
		() =>
			harness.folder.files.document(PATH).getSnapshot().saveError !== undefined,
		'the failed autosave after leaving the row view',
	);
	restore();
	let copied: string | undefined;
	const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (value: string) => {
				copied = value;
			},
		},
	});
	try {
		click(harness.target, 'Copy your text');
		await until(() => copied !== undefined, 'the copied row input');
		expect(copied ?? '').toContain('Kept row input');
		await harness.deleteElsewhere('one');
		await until(
			() => isMissing(harness.folder.files.document(PATH)),
			'the foreign deletion',
		);
		flushSync();
		copied = undefined;
		click(harness.target, 'Copy your text');
		await until(() => copied !== undefined, 'the copied input after deletion');
		expect(copied ?? '').toContain('Kept row input');
	} finally {
		if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
		else Reflect.deleteProperty(navigator, 'clipboard');
	}
});

test('a thought typed and not added writes nothing, and leaving the capture clears it', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), 'not added yet');
	flushSync();
	expect(harness.target.textContent).toContain(
		'Not added yet. Leaving this capture clears it.',
	);
	expect(harness.context.getStatus().unsaved).toEqual([]);
	expect(harness.context.getStatus().saving).toBe(false);
	expect(await harness.text(PATH)).toBe(FILE);

	harness.captures.leave();
	flushSync();
	await harness.captures.open('one', 'capture');
	await settle(harness);
	expect(field('new-thought')?.value).toBe('');
	expect(await harness.text(PATH)).toBe(FILE);
});

test('a blank thought is refused and its text stays', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), '  \n');
	submit(field('new-thought')?.form);
	flushSync();
	expect(field('new-thought')?.value).toBe('  \n');
	expect(
		harness.target.querySelector('[aria-label="Not applied"]')?.textContent,
	).toContain('Write something first.');
	await settle(harness);
	expect(await harness.text(PATH)).toBe(FILE);
});

// The thought's Actions menu is driven in Chromium by the browser smoke: a
// bits-ui menu opened in jsdom leaves effects that later tests read.
test("a thought's Edit as text opens the file with that thought's lines selected", async () => {
	const crlf = `---\r\ncapturedAt: ${AT}\r\n---\r\n\r\nText\r\n\r\n## Thoughts\r\n\r\n- first\r\n- second\r\n  more\r\n`;
	const harness = await setup({ [PATH]: crlf }, 'capture');
	// What the menu item does, over the list the view shows.
	const actions = createCaptureActions(
		harness.folder.tables.captures.document('one'),
	);
	const range = actions.locateThought(1, ['first', 'second\nmore']);
	if (range === undefined) throw new Error('The thought was not found');
	harness.captures.open('one', 'text', range);
	await until(() => {
		flushSync();
		return (
			harness.target.querySelector('textarea[aria-label^="Contents of"]') !==
			null
		);
	}, 'the text view');
	const contents = harness.target.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);
	if (contents === null) throw new Error('No text view');
	expect(
		contents.value.slice(contents.selectionStart, contents.selectionEnd),
	).toBe('- second\n  more');
	expect(document.activeElement).toBe(contents);

	// Unfinished Markdown in the thought is held and saved as typed, CRLF kept.
	type(contents, contents.value.replace('  more', '  more ```ts\n  half'));
	flushSync();
	// The selection is made once, as the text appears, not again as it changes.
	expect(contents.selectionStart).toBe(contents.value.length);
	blur(contents);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(
		crlf.replace('  more\r\n', '  more ```ts\r\n  half\r\n'),
	);
});

test('a thought typed and not added stays visible to copy when the capture stops reading as text and thoughts', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	type(field('new-thought'), 'my pending thought');
	await harness.writeElsewhere(
		PATH,
		`---\ncapturedAt: ${AT}\n---\n\n## Thoughts\n\n## Thoughts\n`,
	);
	await until(() => {
		flushSync();
		return (
			harness.target.textContent?.includes(
				'cannot be edited as text and thoughts',
			) ?? false
		);
	}, 'the refusal');
	const pending = harness.target.querySelector<HTMLTextAreaElement>(
		'[aria-label="Thought not added"]',
	);
	expect(pending?.value).toBe('my pending thought');
	expect(pending?.readOnly).toBe(true);
	expect(
		harness.context.getStatus().saving ||
			harness.context.getStatus().unsaved.length > 0,
	).toBe(false);
});

test('a file that is not a valid capture shows its issues, and opens as a capture once fixed', async () => {
	const broken = '---\ncapturedAt: nope\n---\n\nBroken\n\n## Thoughts\n';
	const harness = await setup({ [PATH]: broken }, 'capture');
	expect(harness.captures.opened).toEqual({ stem: 'one', mode: 'text' });
	const contents = harness.target.querySelector('textarea');
	expect(contents?.value).toBe(broken);
	expect(harness.target.textContent).toContain('Needs repair');
	expect(harness.target.textContent).toContain('Line 2:');
	expect(button(harness.target, 'Open as capture').disabled).toBe(true);

	const fixed = `---\ncapturedAt: ${AT}\n---\n\nRepaired\n\n## Thoughts\n`;
	type(contents, fixed);
	blur(contents);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(fixed);
	expect(harness.target.textContent).not.toContain('Needs repair');
	click(harness.target, 'Open as capture');
	await until(
		() => harness.captures.opened?.mode === 'capture',
		'the capture view',
	);
	await settle(harness);
	expect(field('capture-text')?.value).toBe('Repaired');
});

test('editing a CRLF file as text shows LF lines and writes CRLF back', async () => {
	const broken = '---\r\ncapturedAt: nope\r\n---\r\n\r\nBroken\r\n';
	const harness = await setup({ [PATH]: broken }, 'text');
	const contents = harness.target.querySelector('textarea');
	expect(contents?.value).toBe(broken.replaceAll('\r\n', '\n'));

	type(contents, `---\ncapturedAt: ${AT}\n---\n\nRepaired\n`);
	blur(contents);
	await settle(harness);
	expect(await harness.text(PATH)).toBe(
		`---\r\ncapturedAt: ${AT}\r\n---\r\n\r\nRepaired\r\n`,
	);
});

test('while the folder closes, the text boxes take nothing', async () => {
	const harness = await setup({ [PATH]: FILE }, 'capture');
	await harness.context.close();
	flushSync();
	expect(field('capture-text')?.readOnly).toBe(true);
	expect(field('new-thought')?.readOnly).toBe(true);
	type(field('capture-text'), 'Too late');
	type(field('new-thought'), 'Too late');
	submit(field('new-thought')?.form);
	flushSync();
	expect(
		harness.folder.tables.captures.document('one').getSnapshot().isDirty,
	).toBe(false);
	expect(await harness.text(PATH)).toBe(FILE);
});
