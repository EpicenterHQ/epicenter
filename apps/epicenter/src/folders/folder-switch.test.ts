/**
 * Folder Switch Tests
 *
 * Drives the Folders window's drafts and its choice of open folder over a
 * stand-in folder whose saves a test holds open or refuses, as an editor and
 * the folder list drive them.
 *
 * Key behaviors:
 * - Typing is held by the folder, not the editor: a save sent as one file's
 *   editor goes away and fails keeps the typing and its error, and the file
 *   shows them when chosen again; Try again saves it
 * - A landed save reads the file again before its draft goes; typing that
 *   followed it stays, starting from the content it sent
 * - Choosing another folder while a save fails keeps the open one open, with
 *   its typing editable, and says which files; once saved, choosing again
 *   closes it and opens the other
 * - Choosing another folder, or closing the window, while a save runs waits
 *   for that save before the handle closes
 * - Discard lets typing go only when asked, and not while a save runs
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { describe, expect, test } from 'bun:test';
import type { Folder, SaveError } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';

const { createFileDrafts } = await import('./drafts.svelte.ts');
const { createFolderSwitch } = await import('./folder-switch.svelte.ts');

type Saved = Result<void, SaveError | Error>;

/** A save that has not answered yet, and how the test answers it. */
type HeldSave = {
	path: string;
	content: unknown;
	answer: (result: Saved) => void;
};

const failed = (message: string) =>
	({ data: null, error: new Error(message) }) as unknown as Saved;

/** A folder whose every save waits for the test to answer it. */
function standIn(id: string, log: string[]) {
	const held: HeldSave[] = [];
	const folder = {
		files: {
			write(path: string, _from: unknown, content: unknown) {
				log.push(`${id}: write ${path}`);
				return new Promise<Saved>((answer) =>
					held.push({ path, content, answer }),
				);
			},
		},
		onChange: () => () => {},
		async close() {
			log.push(`${id}: close`);
		},
	} as unknown as Folder<Record<never, never>>;
	return {
		folder,
		held,
		/** Answer the oldest save still waiting. */
		async answer(result: Saved) {
			await until(() => held.length > 0);
			held.shift()!.answer(result);
		},
	};
}

/** Wait until `done`, letting promises run between checks. */
async function until(done: () => boolean) {
	for (let turn = 0; turn < 50; turn++) {
		if (done()) return;
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
	throw new Error('Never happened');
}

const text = { content: 'a\n', crlf: false };

describe('drafts', () => {
	test('a save that fails as the editor goes keeps the typing for the file chosen again', async () => {
		const log: string[] = [];
		const a = standIn('a', log);
		const reads: string[] = [];
		const drafts = createFileDrafts({
			files: a.folder.files,
			saved: async (path) => void reads.push(path),
		});

		drafts.file('notes.md').type('a\nmine\n', text);
		// The editor goes away as another file is chosen.
		const sent = drafts.file('notes.md').save();
		await a.answer(failed('disk full'));
		await sent;

		const again = drafts.file('notes.md');
		expect(again.text).toBe('a\nmine\n');
		expect(again.error?.message).toBe('disk full');
		expect(drafts.held).toEqual(['notes.md']);
		expect(drafts.failures.map((draft) => draft.path)).toEqual(['notes.md']);

		const retried = again.save();
		await a.answer(Ok(undefined));
		await retried;
		expect(again.held).toBe(false);
		expect(reads).toEqual(['notes.md']);
	});

	test('typing that followed a landed save stays, from the content it sent', async () => {
		const a = standIn('a', []);
		const drafts = createFileDrafts({
			files: a.folder.files,
			saved: async () => {},
		});
		const draft = drafts.file('notes.md');

		draft.type('one\n', { content: 'a\r\n', crlf: true });
		const sent = draft.save();
		await until(() => a.held.length === 1);
		expect(a.held[0]!.content).toBe('one\r\n');
		draft.type('one\ntwo\n', text);
		a.held.shift()!.answer(Ok(undefined));
		await sent;

		expect(draft.text).toBe('one\ntwo\n');
		const next = draft.save();
		await until(() => a.held.length === 1);
		expect(a.held[0]!.content).toBe('one\r\ntwo\r\n');
		a.held.shift()!.answer(Ok(undefined));
		await next;
		expect(draft.held).toBe(false);
	});

	test('discard lets typing go only when asked, and not while it saves', async () => {
		const a = standIn('a', []);
		const drafts = createFileDrafts({
			files: a.folder.files,
			saved: async () => {},
		});
		const draft = drafts.file('notes.md');
		expect(draft.type('x', undefined)).toBe(false);

		draft.type('x', text);
		const sent = draft.save();
		expect(draft.discard()).toBe(false);
		await a.answer(failed('refused'));
		await sent;
		expect(draft.discard()).toBe(true);
		expect(draft.held).toBe(false);
	});
});

describe('choosing a folder', () => {
	function windowOver(log: string[]) {
		const opened = new Map<string, ReturnType<typeof standIn>>();
		const current = createFolderSwitch({
			async open(id) {
				log.push(`${id}: open`);
				const folder = standIn(id, log);
				opened.set(id, folder);
				return Ok(folder.folder);
			},
			watch: (id) => {
				log.push(`${id}: watch`);
				return () => log.push(`${id}: unwatch`);
			},
			saved: async () => {},
		});
		return { current, opened };
	}

	test('a save that fails while another folder is chosen keeps the open one, editable', async () => {
		const log: string[] = [];
		const { current, opened } = windowOver(log);
		await current.choose('a');
		const a = opened.get('a')!;
		current.opened!.drafts.file('notes.md').type('a\nmine\n', text);

		const choosing = current.choose('b');
		await a.answer(failed('disk full'));
		await choosing;

		expect(current.opened?.id).toBe('a');
		expect(current.chosen).toBe('a');
		expect(current.kept?.map((draft) => [draft.path, draft.text])).toEqual([
			['notes.md', 'a\nmine\n'],
		]);
		expect(log).not.toContain('a: close');
		const draft = current.opened!.drafts.file('notes.md');
		expect(draft.locked).toBe(false);
		expect(draft.type('a\nmine, fixed\n', undefined)).toBe(true);

		// Saved now, choosing again goes on.
		const retried = current.choose('b');
		await a.answer(Ok(undefined));
		await retried;
		expect(current.kept).toBeUndefined();
		expect(current.opened?.id).toBe('b');
		expect(log).toEqual([
			'a: open',
			'a: watch',
			'a: write notes.md',
			'a: write notes.md',
			'a: unwatch',
			'a: close',
			'b: open',
			'b: watch',
		]);
	});

	test('the handle closes only after a running save, when another folder is chosen', async () => {
		const log: string[] = [];
		const { current, opened } = windowOver(log);
		await current.choose('a');
		const a = opened.get('a')!;
		const drafts = current.opened!.drafts;
		drafts.file('notes.md').type('a\nmine\n', text);
		void drafts.file('notes.md').save();
		await until(() => a.held.length === 1);

		const choosing = current.choose('b');
		await until(() => drafts.fenced);
		// Input is refused while the folder is being left.
		expect(drafts.file('notes.md').type('late', text)).toBe(false);
		expect(log).not.toContain('a: close');
		a.held.shift()!.answer(Ok(undefined));
		await choosing;

		expect(log.indexOf('a: close')).toBeGreaterThan(
			log.indexOf('a: write notes.md'),
		);
		expect(current.opened?.id).toBe('b');
	});

	test('closing the window waits for a running save, then closes whatever stayed unsaved', async () => {
		const log: string[] = [];
		const { current, opened } = windowOver(log);
		await current.choose('a');
		const a = opened.get('a')!;
		current.opened!.drafts.file('notes.md').type('a\nmine\n', text);
		current.opened!.drafts.file('todo.md').type('a\ntodo\n', text);

		const closing = current.close();
		await until(() => a.held.length === 2);
		expect(log).not.toContain('a: close');
		a.held.shift()!.answer(Ok(undefined));
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(log).not.toContain('a: close');
		a.held.shift()!.answer(failed('disk full'));

		const unsaved = await closing;
		expect(unsaved.map((draft) => [draft.path, draft.error?.message])).toEqual([
			['todo.md', 'disk full'],
		]);
		expect(log.slice(-2)).toEqual(['a: unwatch', 'a: close']);
		expect(current.opened).toBeUndefined();
	});

	test('a folder chosen while another is being left opens once it closed', async () => {
		const log: string[] = [];
		const { current, opened } = windowOver(log);
		await current.choose('a');
		const a = opened.get('a')!;
		current.opened!.drafts.file('notes.md').type('a\nmine\n', text);

		const toB = current.choose('b');
		const toC = current.choose('c');
		await a.answer(Ok(undefined));
		await Promise.all([toB, toC]);

		expect(current.opened?.id).toBe('c');
		expect(log).not.toContain('b: open');
		expect(log.filter((line) => line === 'a: close')).toHaveLength(1);
	});
});
