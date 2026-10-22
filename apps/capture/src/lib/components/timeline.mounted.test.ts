/**
 * Mounted Timeline Tests
 *
 * The real `Timeline`, New capture, and draft views, compiled for the client
 * and mounted in jsdom inside the folder's query client, over the real
 * Capture store and a real local folder on an in-memory IndexedDB.
 *
 * Key behaviors:
 * - New capture's text is the form's: typing writes nothing, and leaving
 *   the timeline clears it
 * - Add capture writes one finished capture, once, and opens Add a thought;
 *   blank text is refused, and a failed Add keeps the text
 * - A draft an earlier version saved is listed apart, autosaves through
 *   Folder, and Add capture finishes that same file; detached controls take
 *   no late input
 * - A file that is not a valid capture is named with why, and opens as text
 * - A capture whose save failed is named, with why, and opens from there
 *
 * jsdom has no layout, selection, or IME; these tests say what a delivered
 * event does, not that a person can type there.
 */
// Before the DOM: once a `window` exists, `fake-indexeddb/auto` installs
// IndexedDB on it rather than on the global the folder reads.
import 'fake-indexeddb/auto';
import '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { afterEach, expect, test } from 'bun:test';
import { expectOk } from 'wellcrafted/testing';
import {
	button,
	click,
	setWide,
	type,
} from '../../../../../packages/svelte/src/svelte-dom.test-support.js';
import { isMissing } from '../local-folder.test-support.js';

const { flushSync, mount, tick, unmount } = await import('svelte');
const { openCaptures, until } = await import('../local-folder.test-support.js');
const { default: ViewHost } = await import('./fixtures/ViewHost.svelte');

// A desktop-width window: `min-width` queries match, so the UI kit's modal
// renders as a dialog.
setWide(true);

/** The textarea or input with this id, or `null`. */
const fileField = () =>
	document.querySelector<HTMLTextAreaElement>(
		'textarea[aria-label^="Contents of"]',
	);

const field = (id: string) =>
	document.getElementById(id) as HTMLTextAreaElement | null;

/** Dispatch the submit event a form delivers, on the form itself. */
function submit(form: Element | null | undefined) {
	if (!(form instanceof HTMLFormElement)) throw new Error('Expected a form');
	form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const done of cleanup.splice(0)) await done();
});

async function setup(files: Record<string, string> = {}) {
	const harness = await openCaptures(files);
	const target = document.createElement('main');
	document.body.replaceChildren(target);
	const view = mount(ViewHost, {
		target,
		props: { captures: harness.captures },
	});
	let mounted = true;
	const close = () => {
		if (!mounted) return;
		mounted = false;
		void unmount(view);
	};
	cleanup.push(async () => {
		close();
		await harness.close();
	});
	await harness.quiet();
	flushSync();
	return { ...harness, close };
}

/** Nothing is typed into the folder, saving, or written. */
async function nothingWritten(t: Awaited<ReturnType<typeof setup>>) {
	const status = t.context.getStatus();
	expect(status.saving).toBe(false);
	expect(status.unsaved).toEqual([]);
	return expectOk(await t.folder.tables.captures.list());
}

const AT = '2026-10-04T20:49:23Z';
const DRAFT = 'captures/draft.md';
/** A draft file as an earlier version saved it: `raw` is its whole body. */
const draftFile = (raw: string) =>
	`---\ncapturedAt: ${AT}\ndraft: true\n---\n${raw}`;

/** A timeline over one draft an earlier version saved; open it from Drafts. */
async function openDraft(raw = '') {
	const t = await setup({ [DRAFT]: draftFile(raw) });
	document
		.querySelector<HTMLButtonElement>('[aria-label="Draft captures"] button')
		?.click();
	await until(() => {
		flushSync();
		return fileField() !== null;
	}, 'the draft to open');
	const box = fileField();
	if (box === null) throw new Error('the draft did not open');
	return { t, box, edit: t.folder.tables.captures.edit('draft') };
}

test('New capture text writes nothing, and leaving the timeline clears it', async () => {
	const t = await setup({
		'captures/one.md': `---\ncapturedAt: ${AT}\n---\n\nAn older capture\n`,
	});
	type(field('new-capture'), 'typed, not added');
	flushSync();
	expect(field('new-capture')?.value).toBe('typed, not added');
	expect(document.body.textContent).toContain('Ctrl or ⌘ + Enter adds it.');
	expect(await nothingWritten(t)).toHaveLength(1);

	t.captures.open('one', 'capture');
	flushSync();
	expect(field('new-capture')).toBeNull();
	t.captures.leave();
	flushSync();
	expect(field('new-capture')?.value).toBe('');
	expect(await nothingWritten(t)).toHaveLength(1);
});

test('Add capture writes one finished capture, once, and opens Add a thought focused', async () => {
	const t = await setup();
	expect(document.body.textContent).toContain('No captures yet');
	type(field('new-capture'), 'Written here\nwith two lines');
	flushSync();
	const form = field('new-capture')?.form;
	submit(form);
	// A second Add while the first runs does nothing, and the text takes no typing.
	submit(form);
	flushSync();
	expect(field('new-capture')?.readOnly).toBe(true);
	expect(button(document, 'Adding…').disabled).toBe(true);

	await until(() => {
		flushSync();
		return field('new-thought') !== null;
	}, 'the new capture to open');
	await t.quiet();
	const rows = expectOk(await t.folder.tables.captures.list());
	expect(rows).toHaveLength(1);
	expect(rows[0]?.fields?.draft).toBeUndefined();
	expect(rows[0]?.body).toBe('\nWritten here\nwith two lines\n\n## Thoughts\n');
	expect(t.captures.opened?.stem).toBe(rows[0]?.id);
	expect(document.activeElement).toBe(field('new-thought'));
});

test('blank text cannot be added, and nothing is written', async () => {
	const t = await setup();
	type(field('new-capture'), '  \n ');
	flushSync();
	expect(button(document, 'Add capture').disabled).toBe(true);
	submit(field('new-capture')?.form);
	await tick();
	flushSync();
	expect(t.captures.opened).toBeUndefined();
	expect(await nothingWritten(t)).toEqual([]);
});

test('a failed Add keeps the text and says why; Add again writes it once', async () => {
	const t = await setup();
	const restore = t.failSaves();
	type(field('new-capture'), 'Kept through a full disk');
	flushSync();
	click(document, 'Add capture');
	await until(() => {
		flushSync();
		return (
			document.body.textContent?.includes('The capture was not added') ?? false
		);
	}, 'the Add failure');
	expect(document.body.textContent).toContain('Your text is still here.');
	expect(field('new-capture')?.value).toBe('Kept through a full disk');
	expect(field('new-capture')?.readOnly).toBe(false);
	restore();
	expect(await nothingWritten(t)).toEqual([]);

	click(document, 'Add capture');
	await until(() => {
		flushSync();
		return field('new-thought') !== null;
	}, 'the new capture to open');
	const rows = expectOk(await t.folder.tables.captures.list());
	expect(rows.map((row) => row.body)).toEqual([
		'\nKept through a full disk\n\n## Thoughts\n',
	]);
});

test('a file that is not a valid capture is named with why, and Edit as text opens it', async () => {
	const t = await setup({
		'captures/broken.md': '---\ncapturedAt: nope\n---\n\nBroken\n',
	});
	expect(document.body.textContent).toContain('captures/broken.md');
	expect(document.body.textContent).toContain('capturedAt');
	click(document, 'Edit as text');
	await t.quiet();
	flushSync();
	expect(t.captures.opened).toEqual({ stem: 'broken', mode: 'text' });
	await until(() => {
		flushSync();
		return document.body.textContent?.includes('Needs repair') ?? false;
	}, 'the acquired text repair issues');
});

test('a capture whose save failed is named, with why, and opens from there', async () => {
	const t = await setup({
		'captures/one.md': `---\ncapturedAt: ${AT}\n---\n\nText\n`,
	});
	const restore = t.failSaves();
	const edit = t.folder.tables.captures.edit('one');
	expectOk(await edit.refresh());
	expectOk(edit.change({ body: '\nEdited\n' }));
	await edit.save();
	restore();
	flushSync();

	const notice = document.querySelector('[aria-label="Not saved"]');
	expect(notice?.textContent).toContain('captures/one.md');
	expect(notice?.textContent).toContain('the disk is full');
	// The failed edit stays held, so nothing settles: wait for the capture to open.
	click(document, 'Open');
	await until(() => t.captures.opened !== undefined, 'the capture to open');
	expect(t.captures.opened).toEqual({ stem: 'one', mode: 'capture' });
});

test('a draft an earlier version saved is listed apart, autosaves, and Add capture finishes the same file', async () => {
	const { t, box, edit } = await openDraft();
	expect(t.captures.opened).toEqual({ stem: 'draft', mode: 'text' });
	expect(box.value).toBe(draftFile(''));
	type(box, draftFile('Written in the draft'));
	expect(edit.getSnapshot().content?.body).toBe('Written in the draft');
	await t.quiet();
	expect(await t.text(DRAFT)).toBe(draftFile('Written in the draft'));

	click(document, 'Add capture');
	await until(() => {
		flushSync();
		return field('new-thought') !== null;
	}, 'the finished capture');
	await t.quiet();
	expect(t.captures.opened?.stem).toBe('draft');
	expect(t.cached('draft')?.fields?.draft).toBeUndefined();
	expect(await t.text(DRAFT)).toContain(
		'\nWritten in the draft\n\n## Thoughts\n',
	);
	expect(document.activeElement).toBe(field('new-thought'));
});

test('the draft text box writes nothing after its view is gone', async () => {
	const { t, box, edit } = await openDraft();
	type(box, draftFile('typed in the draft'));
	expect(edit.getSnapshot().content?.body).toBe('typed in the draft');

	t.close();
	flushSync();
	type(box, draftFile('delivered after the view went'));
	expect(edit.getSnapshot().content?.body).toBe('typed in the draft');
	expect(t.captures.fenced).toBe(false);
});

test('a failed promotion keeps original writing visible and retry adds it once', async () => {
	const { t, box } = await openDraft();
	type(box, draftFile('My original writing'));
	await t.quiet();
	const restore = t.failSaves();
	click(document, 'Add capture');
	await until(
		() =>
			document.body.textContent?.includes('The capture was not added') ?? false,
		'the Add failure',
	);
	expect(fileField()?.value).toBe(draftFile('My original writing'));
	restore();
	click(document, 'Add capture');
	await until(() => field('new-thought') !== null, 'the completed capture');
	await t.quiet();
	expect((await t.text(DRAFT))?.match(/^## Thoughts$/gm)).toHaveLength(1);
});

test('a failed draft autosave exposes retry and keeps its writing', async () => {
	const { t, box } = await openDraft();
	const restore = t.failSaves();
	type(box, draftFile('```ts\nstill writing'));
	await until(
		() =>
			document.body.textContent?.includes('Your edit is not saved') ?? false,
		'the autosave failure',
	);
	expect(fileField()?.value).toBe(draftFile('```ts\nstill writing'));
	restore();
	click(document, 'Save again');
	await t.quiet();
	expect(document.body.textContent).not.toContain('Your edit is not saved');
	expect(await t.text(DRAFT)).toBe(draftFile('```ts\nstill writing'));
});

test('stale draft events after Add cannot replace the completed capture', async () => {
	const { t, box } = await openDraft();
	const add = button(document, 'Add capture');
	type(box, draftFile('Final writing'));
	flushSync();
	click(document, 'Add capture');
	await until(() => field('new-thought') !== null, 'the completed capture');
	const before = await t.text(DRAFT);
	expect(before).toContain('\nFinal writing\n\n## Thoughts\n');
	type(box, draftFile('Late raw writing'));
	add.click();
	await t.quiet();
	expect(await t.text(DRAFT)).toBe(before);
});

test('another tab finishing a draft keeps the full-file editor and shows the completed source', async () => {
	const { t, box, edit } = await openDraft('Final writing');
	const completed =
		'---\ncapturedAt: 2026-10-21T10:00:00Z\n---\n\nFinal writing\n\n## Thoughts\n';
	await t.writeElsewhere(DRAFT, completed);
	expectOk(await edit.refresh());
	await until(() => {
		flushSync();
		return box.value === completed;
	}, 'the completed file');
	expect(box.isConnected).toBe(true);
	expect(document.body.textContent).not.toContain('Add capture');
	type(box, completed.replace('Final writing', 'Edited after finishing'));
	await t.quiet();
	expect(await t.text(DRAFT)).toBe(
		completed.replace('Final writing', 'Edited after finishing'),
	);
});

test('repairing draft frontmatter opens its raw writing despite an ambiguous Thoughts body', async () => {
	const raw = '## Thoughts\n\n- original\n\n```';
	const t = await setup({
		'captures/broken.md': `---\ncapturedAt: nope\ndraft: true\n---\n${raw}`,
	});
	click(document, 'Edit as text');
	await until(
		() =>
			document.querySelector('textarea[aria-label^="Contents of"]') !== null,
		'the repair editor',
	);
	type(
		document.querySelector('textarea[aria-label^="Contents of"]'),
		`---\ncapturedAt: 2026-10-01T10:30:00Z\ndraft: true\n---\n${raw}`,
	);
	flushSync();
	await until(() => {
		flushSync();
		return !button(document, 'Add capture').disabled;
	}, 'the repaired draft');
	expect(fileField()?.value).toBe(
		`---\ncapturedAt: 2026-10-01T10:30:00Z\ndraft: true\n---\n${raw}`,
	);
	expect(document.body.textContent).not.toContain('Needs repair');
	await t.quiet();
});

test('a NUL paste is refused visibly and leaves current source unchanged', async () => {
	const { t, box, edit } = await openDraft('Before');
	type(box, draftFile('Pasted\u0000after'));
	await until(() => {
		flushSync();
		return (
			document.body.textContent?.includes('it contains a NUL character') ??
			false
		);
	}, 'the input refusal');
	expect(edit.getSnapshot().content?.text).toBe(draftFile('Before'));
	expect(edit.getSnapshot().isDirty).toBe(false);
	expect(edit.getSnapshot().saveError).toBeUndefined();
	await until(
		() => fileField()?.value === draftFile('Before'),
		'the input to return to current content',
	);
	expect(await t.text(DRAFT)).toBe(draftFile('Before'));
	type(box, draftFile('Accepted again'));
	await t.quiet();
	expect(document.body.textContent).not.toContain('That change was not made');
	expect(await t.text(DRAFT)).toBe(draftFile('Accepted again'));
});

test('copying held draft input after another tab deletes its file preserves leading blank lines', async () => {
	const { t, box, edit } = await openDraft();
	const raw = '\n\nRaw writing\n';
	const restore = t.failSaves();
	type(box, draftFile(raw));
	await until(
		() =>
			document.body.textContent?.includes('Your edit is not saved') ?? false,
		'the autosave failure',
	);
	restore();
	await t.deleteElsewhere('draft');
	await until(() => isMissing(edit), 'the deleted-file recovery');
	flushSync();
	let copied: string | undefined;
	const original = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (text: string) => {
				copied = text;
			},
		},
	});
	try {
		click(document, 'Copy your text');
		await until(() => copied !== undefined, 'the copied text');
		expect(copied).toBe(draftFile(raw));
	} finally {
		if (original) Object.defineProperty(navigator, 'clipboard', original);
		else Reflect.deleteProperty(navigator, 'clipboard');
	}
});

test('Finish composes pending whole-file content, keeping unknown frontmatter and raw CRLF', async () => {
	const original = draftFile('Before').replace(/\n/g, '\r\n');
	const t = await setup({ [DRAFT]: original });
	document
		.querySelector<HTMLButtonElement>('[aria-label="Draft captures"] button')
		?.click();
	await until(() => {
		flushSync();
		return fileField() !== null;
	}, 'the full-file draft editor');
	const box = fileField();
	const typed = original
		.replace('draft: true', 'draft: true\r\nunknown: kept')
		.replace('Before', 'New\r\nbody');
	type(box, typed);
	const edit = t.folder.tables.captures.edit('draft');
	expect(edit.getSnapshot().content?.text).toBe(typed);
	click(document, 'Add capture');
	await until(() => {
		flushSync();
		return field('new-thought') !== null;
	}, 'the finished capture');
	await t.quiet();
	const row = expectOk(await t.folder.tables.captures.get('draft'));
	expect(row?.body).toBe('\nNew\r\nbody\n\n## Thoughts\n');
	expect(row?.text).toContain('unknown: kept\r\n');
	expect(row?.fields?.draft).toBeUndefined();
	expect(expectOk(await t.folder.tables.captures.list())).toHaveLength(1);
});

test('input accepted after Finish writes remains current through its refresh', async () => {
	const { t, box } = await openDraft('Final writing');
	const refresh = t.context.refresh;
	let release!: () => void;
	const waiting = new Promise<void>((resolve) => {
		release = resolve;
	});
	let refreshing = false;
	t.context.refresh = async (paths) => {
		await refresh(paths);
		refreshing = true;
		await waiting;
	};
	try {
		click(document, 'Add capture');
		await until(() => {
			flushSync();
			return refreshing;
		}, 'Finish to write and refresh');
		expect(box.readOnly).toBe(false);
		const finished = await t.text(DRAFT);
		if (finished === undefined) throw new Error('The promotion did not save');
		const newer = finished.replace(
			'Final writing',
			'New typing during refresh',
		);
		type(box, newer);
		expect(
			t.folder.tables.captures.edit('draft').getSnapshot().content?.text,
		).toBe(newer);
		expect(t.folder.tables.captures.edit('draft').getSnapshot().isDirty).toBe(
			true,
		);
		release();
		await until(() => {
			flushSync();
			return field('new-thought') !== null;
		}, 'the finished view');
		await t.quiet();
		expect(await t.text(DRAFT)).toBe(newer);
	} finally {
		release();
		t.context.refresh = refresh;
	}
});

test('a failed draft save reopens from the failure list in the full-file editor', async () => {
	const t = await setup({ [DRAFT]: draftFile('Before') });
	const edit = t.folder.tables.captures.edit('draft');
	expectOk(await edit.refresh());
	const restore = t.failSaves();
	expectOk(edit.replaceText(draftFile('Held here')));
	await edit.save();
	flushSync();
	click(document, 'Open');
	await until(() => {
		flushSync();
		return fileField() !== null;
	}, 'the failed draft');
	expect(t.captures.opened).toEqual({ stem: 'draft', mode: 'text' });
	expect(fileField()?.value).toBe(draftFile('Held here'));
	expect(document.body.textContent).toContain('Add capture');
	restore();
	click(document, 'Save again');
	await t.quiet();
});

test('a capture that becomes a draft offers an explicit text editor that stays mounted during frontmatter repair', async () => {
	const t = await setup({
		[DRAFT]: draftFile('Before').replace('draft: true\n', ''),
	});
	t.captures.open('draft', 'capture');
	await until(() => {
		flushSync();
		return field('new-thought') !== null;
	}, 'the capture');
	type(field('new-thought'), 'Not added yet');
	const oldCaptureText = field('capture-text');
	await t.writeElsewhere(DRAFT, draftFile('Before'));
	expectOk(await t.folder.tables.captures.edit('draft').refresh());
	type(oldCaptureText, 'Stale structured input');
	expect(
		t.folder.tables.captures.edit('draft').getSnapshot().content?.body,
	).toBe('Before');
	await until(() => {
		flushSync();
		return document.body.textContent?.includes('This file is a draft') ?? false;
	}, 'the draft notice');
	expect(
		document.querySelector<HTMLTextAreaElement>(
			'[aria-label="Thought not added"]',
		)?.value,
	).toBe('Not added yet');
	expect(fileField()).toBeNull();
	click(document, 'Edit as text');
	await until(() => {
		flushSync();
		return fileField() !== null;
	}, 'the text editor');
	const box = fileField();
	type(box, draftFile('Before').replace('draft: true', 'draft: tru'));
	flushSync();
	expect(box?.isConnected).toBe(true);
	expect(fileField()).toBe(box);
	expect(document.body.textContent).toContain('Needs repair');
	type(box, draftFile('Repaired'));
	flushSync();
	expect(fileField()).toBe(box);
	expect(button(document, 'Add capture').disabled).toBe(false);
	await t.quiet();
});
