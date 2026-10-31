/**
 * What Capture does with the list it is given: the timeline, which capture
 * is open and how, Add, and deletion.
 *
 * The list is one store's captures for the page's whole life; the root that
 * passes it chooses the store (the person's `capture` repository, ADR-0700).
 * Add writes a capture to that store, where it is a commit. The timeline
 * shows the list newest first.
 */
import {
	type CaptureNote,
	type CaptureNotes,
	capture,
	captureBody,
	capturePath,
	composeBody,
	excerpt,
	type InvalidCapture,
} from '@epicenter/capture';
import {
	type ClientError,
	describeIssues,
	noteText,
} from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import type { ReactiveNotes } from '@epicenter/svelte/client';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { TextRange } from './capture-actions.svelte.js';

/** The captures a page reads and edits: its store's. */
export type CaptureList = ReactiveNotes<CaptureNotes>;
export type Captures = ReturnType<typeof createCaptures>;
export type Mode = 'capture' | 'text';
export type Focus = 'new-thought' | TextRange;
export type Opened = {
	readonly id: string;
	readonly mode: Mode;
	readonly focus?: Focus;
};
export type TimelineRow = {
	readonly id: string;
	readonly capturedAt: Date | undefined;
	readonly preview: string;
	readonly thoughtCount: number;
};
/** A capture's file that opens as text: it does not read, or its Thoughts are ambiguous. */
export type Repair = {
	readonly id: string;
	readonly path: string;
	readonly problem: string;
};
/** A file at a capture's path that is not text: listed, never opened. */
export type NotText = { readonly id: string; readonly path: string };
export type Deletion = { readonly id: string; readonly title: string };

export const CaptureError = defineErrors({
	Refused: ({ message }: { message: string }) => ({ message }),
});
export type CaptureError = InferErrors<typeof CaptureError>;
export type Failure = ClientError | CaptureError;

export function instantOf(value: unknown): Date | undefined {
	if (typeof value !== 'string') return undefined;
	const time = new Date(value);
	return Number.isNaN(time.getTime()) ? undefined : time;
}

/** Newest first by the instant captured, then by id: an offset time sorts by when it was, not its text. */
export function newestFirst(
	left: Pick<CaptureNote, 'id' | 'capturedAt'>,
	right: Pick<CaptureNote, 'id' | 'capturedAt'>,
) {
	const a = instantOf(left.capturedAt)?.getTime();
	const b = instantOf(right.capturedAt)?.getTime();
	if (a !== b) {
		if (a === undefined) return 1;
		if (b === undefined) return -1;
		return b - a;
	}
	return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/** The house-style text of a capture as shown: its file's text when Capture or Epicenter wrote it. */
export const captureText = (note: CaptureNote) =>
	noteText(capture.collections.captures, note);

/** The text and thoughts of a capture's body, or why its Thoughts are ambiguous. */
export const readCaptureBody = (note: Pick<CaptureNote, 'body'>) =>
	captureBody.decode(note.body);

/**
 * What the timeline shows: captures newest first, files that open as text
 * to repair, and files that are not text.
 */
export function timelineOf(
	items: readonly CaptureNote[],
	invalid: readonly InvalidCapture[],
) {
	const rows: TimelineRow[] = [];
	const repairs: Repair[] = [];
	const notText: NotText[] = [];
	for (const note of items.toSorted(newestFirst)) {
		const reading = readCaptureBody(note);
		if (reading.error !== null) {
			repairs.push({
				id: note.id,
				path: capturePath(note.id),
				problem: reading.error.message,
			});
			continue;
		}
		rows.push({
			id: note.id,
			capturedAt: instantOf(note.capturedAt),
			preview: excerpt(reading.data.text),
			thoughtCount: reading.data.thoughts.length,
		});
	}
	for (const file of invalid) {
		if (file.text === null) notText.push({ id: file.id, path: file.path });
		else
			repairs.push({
				id: file.id,
				path: file.path,
				problem: describeIssues(file.issues),
			});
	}
	const byPath = (a: { path: string }, b: { path: string }) =>
		a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
	return { rows, repairs: repairs.sort(byPath), notText };
}

/** What the page does with `list`, its store's captures. */
export function createCaptures(list: CaptureList) {
	let opened = $state.raw<Opened | undefined>();
	let navigation = 0;
	const timeline = $derived(timelineOf(list.items, list.invalid));

	/** Open `id` as asked, unless a later navigation came first; a capture that does not read opens as text. */
	function go(requested: number, id: string, mode: Mode, focus?: Focus) {
		if (requested !== navigation) return;
		if (mode === 'capture') {
			const note = list.get({ id });
			if (note === undefined || readCaptureBody(note).error !== null) {
				mode = 'text';
				focus = undefined;
			}
		}
		if (focus !== undefined || opened?.id !== id || opened.mode !== mode)
			opened = { id, mode, focus };
	}

	return {
		list,
		get timeline() {
			return timeline;
		},
		get opened() {
			return opened;
		},
		open(id: string, mode: Mode, focus?: Focus) {
			go(++navigation, id, mode, focus);
		},
		leave() {
			++navigation;
			opened = undefined;
		},
		/** Add `text` as a new capture, then open it at Add a thought. */
		async create(text: string): Promise<Result<{ id: string }, Failure>> {
			if (text.trim() === '')
				return CaptureError.Refused({ message: 'Write something first.' });
			const requested = ++navigation;
			const now = new Date();
			const id = timeId(now);
			const created = await list.create({
				id,
				capturedAt: now.toISOString(),
				body: composeBody(text).body,
			});
			if (created.error !== null) return created;
			go(requested, id, 'capture', 'new-thought');
			return Ok({ id });
		},
		deletionFor(id: string): Deletion {
			const note = list.get({ id });
			const reading = note && readCaptureBody(note).data;
			return { id, title: reading?.text.trim().slice(0, 60) ?? '' };
		},
		/** Delete the capture as shown; one changed elsewhere since is a `Conflict`, and stays. */
		async delete(deletion: Deletion) {
			const deleted = await list.delete({ id: deletion.id });
			if (deleted.error === null && opened?.id === deletion.id) {
				++navigation;
				opened = undefined;
			}
			return deleted;
		},
	};
}
