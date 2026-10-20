/**
 * File Draft Tests
 *
 * Drives a folder editor window's drafts over a stand-in folder whose saves a
 * test holds open or refuses, as the editor and the window's lifetime drive
 * them.
 *
 * Key behaviors:
 * - Typing is held by the window, not the editor: a save sent as one file's
 *   editor goes away and fails keeps the typing and its error, and the file
 *   shows them when chosen again; Try again saves it
 * - A landed save reads the file again before its draft goes; typing that
 *   followed it stays, starting from the content it sent, with the file's
 *   own line endings
 * - Settling sends every draft and waits for every save started, refuses no
 *   input, and answers what is still held; typing after it goes on and saves
 * - The drafts are busy while typing is held or a save runs, and a failed
 *   save stays busy and failed until it saves or is discarded
 * - Discard lets typing go only when asked, and not while a save runs
 */
import '../../../../packages/svelte/src/svelte-modules.test-support.js';
import { describe, expect, test } from 'bun:test';
import type { FolderFiles, SaveError } from '@epicenter/folder';
import { Ok, type Result } from 'wellcrafted/result';

const { createFileDrafts } = await import('./drafts.svelte.ts');

type Saved = Result<void, SaveError | Error>;

/** A save that has not answered yet, and how the test answers it. */
type HeldSave = {
	path: string;
	content: unknown;
	answer: (result: Saved) => void;
};

const failed = (message: string) =>
	({ data: null, error: new Error(message) }) as unknown as Saved;

/** Files whose every save waits for the test to answer it. */
function standIn() {
	const held: HeldSave[] = [];
	const files = {
		write(path: string, _from: unknown, content: unknown) {
			return new Promise<Saved>((answer) =>
				held.push({ path, content, answer }),
			);
		},
	} as unknown as Pick<FolderFiles, 'write'>;
	return {
		files,
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
		const disk = standIn();
		const reads: string[] = [];
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async (path) => void reads.push(path),
		});

		drafts.file('notes.md').type('a\nmine\n', text);
		// The editor goes away as another file is chosen.
		const sent = drafts.file('notes.md').save();
		await disk.answer(failed('disk full'));
		await sent;

		const again = drafts.file('notes.md');
		expect(again.text).toBe('a\nmine\n');
		expect(again.error?.message).toBe('disk full');
		expect(drafts.held).toEqual(['notes.md']);
		expect(drafts.failures.map((draft) => draft.path)).toEqual(['notes.md']);

		const retried = again.save();
		await disk.answer(Ok(undefined));
		await retried;
		expect(again.held).toBe(false);
		expect(reads).toEqual(['notes.md']);
	});

	test('typing that followed a landed save stays, from the content it sent', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('notes.md');

		draft.type('one\n', { content: 'a\r\n', crlf: true });
		const sent = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]!.content).toBe('one\r\n');
		draft.type('one\ntwo\n', text);
		disk.held.shift()!.answer(Ok(undefined));
		await sent;

		expect(draft.text).toBe('one\ntwo\n');
		const next = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]!.content).toBe('one\r\ntwo\r\n');
		disk.held.shift()!.answer(Ok(undefined));
		await next;
		expect(draft.held).toBe(false);
	});

	test('discard lets typing go only when asked, and not while it saves', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('notes.md');
		expect(draft.type('x', undefined)).toBe(false);

		draft.type('x', text);
		const sent = draft.save();
		expect(draft.discard()).toBe(false);
		await disk.answer(failed('refused'));
		await sent;
		expect(draft.discard()).toBe(true);
		expect(draft.held).toBe(false);
	});
});

describe('settling', () => {
	test('settling sends every draft and waits for its save, and typing goes on after it', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		drafts.file('a.md').type('a\nmine\n', text);
		drafts.file('b.md').type('a\ntheirs\n', text);
		expect(drafts.busy).toBe(true);

		// The window is hidden: what is typed is sent at once.
		let settled = false;
		const settling = drafts.settle().then((held) => {
			settled = true;
			return held;
		});
		await until(() => disk.held.length === 2);
		expect(settled).toBe(false);
		disk.held.shift()!.answer(Ok(undefined));
		disk.held.shift()!.answer(Ok(undefined));
		expect(await settling).toEqual([]);
		expect(drafts.busy).toBe(false);

		// Shown again, the person keeps typing, and it saves as before.
		const draft = drafts.file('a.md');
		expect(
			draft.type('a\nmine\nmore\n', { content: 'a\nmine\n', crlf: false }),
		).toBe(true);
		const sent = draft.save();
		await until(() => disk.held.length === 1);
		expect(disk.held[0]!.content).toBe('a\nmine\nmore\n');
		disk.held.shift()!.answer(Ok(undefined));
		await sent;
		expect(drafts.held).toEqual([]);
	});

	test('a failed save survives settling with its text, busy and failed, and input stays open', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		drafts.file('a.md').type('a\nmine\n', text);

		const settling = drafts.settle();
		await disk.answer(failed('disk full'));
		const held = await settling;
		expect(
			held.map((draft) => [draft.path, draft.text, draft.error?.message]),
		).toEqual([['a.md', 'a\nmine\n', 'disk full']]);
		expect(drafts.busy).toBe(true);
		expect(drafts.failures.map((draft) => draft.path)).toEqual(['a.md']);

		// Settling again tries again; still refused, it answers the same.
		const again = drafts.settle();
		await disk.answer(failed('disk full'));
		expect((await again).map((draft) => draft.path)).toEqual(['a.md']);
		expect(drafts.file('a.md').type('a\nmine\nfixed\n', undefined)).toBe(true);
		expect(drafts.file('a.md').text).toBe('a\nmine\nfixed\n');
	});

	test('a save already running is waited for, and typing during it is answered as held', async () => {
		const disk = standIn();
		const drafts = createFileDrafts({
			files: disk.files,
			saved: async () => {},
		});
		const draft = drafts.file('a.md');
		draft.type('a\none\n', text);
		void draft.save();
		await until(() => disk.held.length === 1);
		expect(drafts.busy).toBe(true);

		const settling = drafts.settle();
		draft.type('a\none\ntwo\n', text);
		disk.held.shift()!.answer(Ok(undefined));
		// The typing that arrived meanwhile is sent in the same round.
		await disk.answer(Ok(undefined));
		expect(await settling).toEqual([]);
		expect(drafts.busy).toBe(false);
	});
});
