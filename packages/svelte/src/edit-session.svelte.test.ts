/**
 * Edit Session Merge Tests
 *
 * Drives a text session over a stand-in file that another writer can change
 * between saves, with the text source's real line merge.
 *
 * Key behaviors:
 * - A change made elsewhere to other lines merges with the draft and saves,
 *   against the value the session last saved rather than the one it opened
 * - Lines both changed become a review with one part; applying a side saves
 *   it over the newer file, guarded by its bytes, and unlocks input
 */
import './svelte-modules.test-support.js';
import { expect, test } from 'bun:test';
import type { FileCapture, FolderFiles, SaveState } from '@epicenter/folder';
import { Ok } from 'wellcrafted/result';

const { createEditSession, textSource } = await import(
	'./edit-session.svelte.ts'
);

type Failure = { name: string; message: string; actualSha256?: string };

/** One text file, its bytes named by a counter, saved through a guarded stand-in autosave. */
function storedText(initial: string) {
	const file = { text: initial, version: 0 };
	const capture = (): FileCapture => ({
		path: 'notes.txt',
		sha256: String(file.version),
	});
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
						const next: SaveState<Failure> =
							confirmed.sha256 === String(file.version)
								? (() => {
										file.text = value;
										file.version += 1;
										confirmed = capture();
										return { status: 'saved', file: confirmed };
									})()
								: {
										status: 'error',
										file: confirmed,
										error: {
											name: 'Conflict',
											message: 'changed elsewhere',
											actualSha256: String(file.version),
										},
									};
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
		async recreate() {
			return Ok(capture());
		},
		merge: textSource({} as FolderFiles).merge,
	};
	return {
		session: createEditSession(source, { file: capture(), value: initial }),
		/** Another writer replaces the file. */
		writeElsewhere(text: string) {
			file.text = text;
			file.version += 1;
		},
		get text() {
			return file.text;
		},
	};
}

test('a change elsewhere to other lines merges against the last saved value, not the opened one', async () => {
	const stored = storedText('a\nb\nc\n');
	stored.session.edit(() => 'A\nb\nc\n');
	expect((await stored.session.settled()).status).toBe('saved');

	stored.writeElsewhere('A\nb\nC\n');
	stored.session.edit(() => 'A2\nb\nc\n');
	const state = await stored.session.settled();

	expect(state.status).toBe('saved');
	expect(stored.session.review).toBeUndefined();
	expect(stored.text).toBe('A2\nb\nC\n');
	expect(stored.session.draft).toBe('A2\nb\nC\n');
});

test('lines both changed become one review part, and applying a side saves it over the newer file', async () => {
	const stored = storedText('a\nb\n');
	stored.writeElsewhere('theirs\nb\n');
	stored.session.edit(() => 'mine\nb\n');
	await stored.session.settled();

	const review = stored.session.review;
	expect(review?.conflicts.map(({ kind }) => kind)).toEqual(['body']);
	expect(stored.session.locked).toBe(true);
	expect(stored.text).toBe('theirs\nb\n');

	const conflict = review?.conflicts[0];
	if (review === undefined || conflict === undefined)
		throw new Error('Expected a review with one part');
	const applied = await review.apply({
		[conflict.id]: { kind: 'take', side: 'incoming' },
	});
	expect(applied.error).toBeNull();
	expect((await stored.session.settled()).status).toBe('saved');
	expect(stored.session.review).toBeUndefined();
	expect(stored.session.locked).toBe(false);
	expect(stored.session.draft).toBe('theirs\nb\n');
	expect(stored.text).toBe('theirs\nb\n');
});
