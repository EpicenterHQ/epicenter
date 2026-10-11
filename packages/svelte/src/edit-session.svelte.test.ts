/**
 * Edit Session Merge Tests
 *
 * Drives a session over a stand-in text file that another writer can change
 * between saves. The stand-in's `merge` records what the session asks and
 * answers as each test chooses; the folder's own merge rules are tested in
 * `@epicenter/folder` (`file-merge.test.ts`).
 *
 * Key behaviors:
 * - A save refused by a change elsewhere asks the folder to merge from the
 *   value the session last saved, not the one it opened
 * - What the folder wrote becomes the draft, with no review
 * - Held parts become a review that locks input; `resolve` writes and unlocks
 * - A refused `resolve` keeps the review with its problems; a further change
 *   elsewhere starts a new one
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import {
	type FileCapture,
	FileError,
	type SaveMerge,
	type SaveState,
	type SyncConflict,
	SyncError,
} from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';

const { createEditSession } = await import('./edit-session.svelte.ts');

type Failure = { name: string; message: string; actualSha256?: string };

const TITLE: SyncConflict = {
	id: 'title',
	kind: 'body',
	path: 'notes.txt',
	base: { present: true, value: 'a' },
	local: { present: true, value: 'mine' },
	incoming: { present: true, value: 'theirs' },
};

/** One text file whose bytes are named by a counter, and a folder stand-in over it. */
function storedText(
	initial: string,
	answer: (versions: { base: string; ours: string }) => SaveMerge,
) {
	const file = { text: initial, version: 0 };
	const asked: { base: string; ours: string }[] = [];
	const capture = (): FileCapture => ({
		path: 'notes.txt',
		sha256: String(file.version),
	});
	/** Write `text` if the file is still at `over`. */
	const write = (over: FileCapture | undefined, text: string) => {
		if (over !== undefined && over.sha256 !== String(file.version))
			return FileError.Conflict({
				path: 'notes.txt',
				expectedSha256: over.sha256,
				actualSha256: String(file.version),
			});
		file.text = text;
		file.version += 1;
		return Ok(capture());
	};
	const source = {
		autosave(
			from: FileCapture,
			{ onState }: { onState(state: SaveState<Failure>): void },
		) {
			let confirmed = from;
			let last = Promise.resolve<SaveState<Failure>>({
				status: 'saved',
				file: from,
			});
			return {
				request(value: string) {
					last = last.then(async () => {
						await Promise.resolve();
						const { data, error } = write(confirmed, value);
						const next: SaveState<Failure> =
							error === null
								? { status: 'saved', file: (confirmed = data) }
								: { status: 'error', file: confirmed, error };
						onState(next);
						return next;
					});
				},
				settled: () => last,
			};
		},
		async reread() {
			return Ok({ kind: 'value' as const, file: capture(), value: file.text });
		},
		async merge(_path: string, versions: { base: string; ours: string }) {
			asked.push(versions);
			return Ok(answer(versions));
		},
	};
	return {
		session: createEditSession(source, { file: capture(), value: initial }),
		asked,
		/** Another writer replaces the file. */
		writeElsewhere(text: string) {
			write(undefined, text);
		},
		/** What a folder's guarded write would do with `text` over the file as it is now. */
		writeOver(over: FileCapture, text: string) {
			return write(over, text);
		},
		capture,
		get text() {
			return file.text;
		},
	};
}

test('a change elsewhere is merged from the last saved value, and what the folder wrote becomes the draft', async () => {
	const stored = storedText('a', () => {
		stored.writeElsewhere('merged');
		return { kind: 'saved', file: stored.capture() };
	});
	stored.session.edit(() => 'b');
	expect((await stored.session.settled()).status).toBe('saved');

	stored.writeElsewhere('theirs');
	stored.session.edit(() => 'c');
	const state = await stored.session.settled();

	expect(stored.asked).toEqual([{ base: 'b', ours: 'c' }]);
	expect(state.status).toBe('saved');
	expect(stored.session.review).toBeUndefined();
	expect(stored.session.draft).toBe('merged');
});

test('held parts become a review that locks input, and resolve writes the choices and unlocks', async () => {
	const stored = storedText('a', () => {
		const over = stored.capture();
		return {
			kind: 'held',
			conflicts: [TITLE],
			async resolve() {
				return stored.writeOver(over, 'chosen');
			},
		};
	});
	stored.writeElsewhere('theirs');
	stored.session.edit(() => 'mine');
	await stored.session.settled();

	const review = stored.session.review;
	expect(review?.conflicts).toEqual([TITLE]);
	expect(stored.session.locked).toBe(true);
	expect(stored.text).toBe('theirs');

	expect((await stored.session.resolve({})).data).toBe('shown');
	expect(stored.session.review).toBeUndefined();
	expect(stored.session.locked).toBe(false);
	expect(stored.session.draft).toBe('chosen');
	expect(stored.text).toBe('chosen');
});

test('a refused resolve keeps the review with its problems, and a further change elsewhere starts a new one', async () => {
	let refuse = true;
	const stored = storedText('a', () => {
		const over = stored.capture();
		return {
			kind: 'held',
			conflicts: [TITLE],
			async resolve() {
				if (refuse)
					return SyncError.InvalidChoices({
						problems: [
							{ conflictId: 'title', reason: 'missing', message: 'Choose' },
						],
					});
				return stored.writeOver(over, 'chosen');
			},
		};
	});
	stored.writeElsewhere('theirs');
	stored.session.edit(() => 'mine');
	await stored.session.settled();
	const first = stored.session.review;

	expect((await stored.session.resolve({})).error?.name).toBe('InvalidChoices');
	expect(stored.session.review?.id).toBe(first?.id);
	expect(stored.session.review?.problems).toEqual([
		{ conflictId: 'title', reason: 'missing', message: 'Choose' },
	]);

	refuse = false;
	stored.writeElsewhere('theirs again');
	expect((await stored.session.resolve({})).error?.name).toBe('Conflict');
	await stored.session.settled();
	expect(stored.session.review).toBeDefined();
	expect(stored.session.review?.id).not.toBe(first?.id);
	expect(stored.asked).toHaveLength(2);
});
