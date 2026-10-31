/**
 * Capture's one list and what the views do with it: the timeline, which
 * capture is open and how, Add, and deletion.
 *
 * The list (`createCaptureList`) is `oneList` over this browser's files and,
 * signed in, the person's `capture` repository (decision 12): the captures
 * still in the browser ("not uploaded yet") and the repository's, newest
 * first. A new capture is always written to the browser first and recorded
 * to upload (`createOn: 'device'`), so Add never waits on the server and
 * works offline; the uploader moves it, and an edit made meanwhile follows.
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
import { type ClientError, noteText } from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import {
	type CaptureQueue,
	type ListedInvalid,
	type ListedNote,
	type OneList,
	oneList,
	type ReactiveNotes,
	type Side,
} from '@epicenter/svelte/client';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';
import type { TextRange } from './capture-actions.svelte.js';

export type CaptureList = OneList<CaptureNotes>;
export type ListedCapture = ListedNote<CaptureNotes>;
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
	readonly where: Side;
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

/** Why a note does not read as a capture, in a line. */
export const describeIssues = (
	issues: readonly { field: string; message: string }[],
) => issues.map(({ message }) => message).join('; ');

/**
 * The house-style text of a capture as shown: its file's text when Capture
 * or Epicenter wrote it. The list's `where` (which copy shows) is not front
 * matter, so it is left out.
 */
export function captureText(note: ListedCapture | CaptureNote) {
	const { where: _where, ...shown } = note as ListedCapture;
	return noteText(capture.collections.captures, shown as CaptureNote);
}

/** The text and thoughts of a capture's body, or why its Thoughts are ambiguous. */
export const readCaptureBody = (note: Pick<CaptureNote, 'body'>) =>
	captureBody.decode(note.body);

/** What the timeline shows: captures, files that open as text to repair, and files that are not text. */
export function timelineOf(
	items: readonly ListedCapture[],
	invalid: readonly (InvalidCapture | ListedInvalid<CaptureNotes>)[],
) {
	const rows: TimelineRow[] = [];
	const repairs: Repair[] = [];
	const notText: NotText[] = [];
	for (const note of items) {
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
			where: note.where,
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

/**
 * The one list over `device` (this browser's files) and `repository` (null
 * signed out). `outbox` is the device's, where new captures wait to upload.
 */
export const createCaptureList = ({
	device,
	repository,
	outbox,
}: {
	device: ReactiveNotes<CaptureNotes>;
	repository: ReactiveNotes<CaptureNotes> | null;
	outbox: CaptureQueue;
}): CaptureList =>
	oneList(capture, 'captures', {
		device,
		repository,
		outbox,
		order: newestFirst,
		createOn: 'device',
	});

/**
 * What the views do with `list`. `uploads` is whether captures in the
 * browser go up to a repository (signed in), so the timeline marks the ones
 * that have not yet.
 */
export function createCaptures(
	list: CaptureList,
	{ uploads }: { uploads: boolean },
) {
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
		uploads,
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
