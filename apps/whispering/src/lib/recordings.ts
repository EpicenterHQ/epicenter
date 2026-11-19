/**
 * Recordings on disk, in `recordings/` in the app's local data directory:
 * `<id>.webm` is the audio the native recorder wrote, and `<id>.md` is the
 * note, whose front matter holds `recordedAt` and `durationMs` and whose
 * body is the transcript. A recording is the two files by id; either can be
 * missing.
 *
 * A note is written to `<id>.md.tmp` and renamed over `<id>.md`, so a crash
 * mid-write leaves the old note whole.
 */
import {
	changeMarkdown,
	type FieldValues,
	readMarkdown,
} from '@epicenter/app/markdown';
import { invoke } from '@tauri-apps/api/core';
import {
	BaseDirectory,
	exists,
	readFile,
	readTextFile,
	remove,
	rename,
	writeTextFile,
} from '@tauri-apps/plugin-fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { recordedAt } from './feed';

/** A recording; its time comes from its id (`recordedAt` in `feed.ts`). */
export type Recording = {
	id: string;
	durationMs: number | undefined;
	transcript: string;
	/** Whether `<id>.webm` is there. */
	audio: boolean;
};

export const RecordingsError = defineErrors({
	ListFailed: ({ cause }: { cause: unknown }) => ({
		message: `Recordings could not be read: ${extractErrorMessage(cause)}`,
		cause,
	}),
	ReadFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Recording ${id} could not be read: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
	WriteFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Recording ${id} could not be saved: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
	DeleteFailed: ({ id, cause }: { id: string; cause: unknown }) => ({
		message: `Recording ${id} could not be deleted: ${extractErrorMessage(cause)}`,
		id,
		cause,
	}),
});
export type RecordingsError = InferErrors<typeof RecordingsError>;

const at = { baseDir: BaseDirectory.AppLocalData };
const notePath = (id: string) => `recordings/${id}.md`;
const audioPath = (id: string) => `recordings/${id}.webm`;

/** What `recordings_list` answers for each id. */
type Listed = { id: string; note: string | null; audio: boolean };

function toRecording({ id, note, audio }: Listed): Recording {
	const { fields, body } = readMarkdown(note ?? '');
	return {
		id,
		durationMs:
			typeof fields.durationMs === 'number' ? fields.durationMs : undefined,
		transcript: body.trim(),
		audio,
	};
}

/** Write `text` to `<id>.md` through a temporary file beside it. */
async function writeNote(id: string, text: string) {
	const temporary = `${notePath(id)}.tmp`;
	await writeTextFile(temporary, text, at);
	await rename(temporary, notePath(id), {
		oldPathBaseDir: BaseDirectory.AppLocalData,
		newPathBaseDir: BaseDirectory.AppLocalData,
	});
}

export const recordings = {
	/** Every recording, oldest first (ids sort by time). One call reads every note. */
	list: () =>
		tryAsync({
			try: async () =>
				(await invoke<Listed[]>('recordings_list')).map(toRecording),
			catch: (cause) => RecordingsError.ListFailed({ cause }),
		}),

	/** The audio of the recording `id`. */
	audio: (id: string) =>
		tryAsync({
			try: async () =>
				new Blob([await readFile(audioPath(id), at)], { type: 'audio/webm' }),
			catch: (cause) => RecordingsError.ReadFailed({ id, cause }),
		}),

	/** Write the note for a take the recorder just finished: its time and length, no transcript yet. */
	addNote: ({ id, durationMs }: { id: string; durationMs: number }) =>
		tryAsync({
			try: () => {
				const time = recordedAt(id)?.toISOString();
				const set: FieldValues = time
					? { recordedAt: time, durationMs }
					: { durationMs };
				return writeNote(id, changeMarkdown('', { set, body: '' }));
			},
			catch: (cause) => RecordingsError.WriteFailed({ id, cause }),
		}),

	/**
	 * Replace the transcript of the recording `id`, keeping every front
	 * matter line as it is. A recording with audio and no note gets one.
	 */
	setTranscript: ({ id, transcript }: { id: string; transcript: string }) =>
		tryAsync({
			try: async () => {
				const before = (await exists(notePath(id), at))
					? await readTextFile(notePath(id), at)
					: '';
				await writeNote(
					id,
					changeMarkdown(before, {
						set: {},
						body: transcript ? `${transcript}\n` : '',
					}),
				);
			},
			catch: (cause) => RecordingsError.WriteFailed({ id, cause }),
		}),

	/** Delete the recording's note and audio, whichever are there. */
	delete: ({ id }: { id: string }) =>
		tryAsync({
			try: async () => {
				for (const path of [notePath(id), audioPath(id)])
					if (await exists(path, at)) await remove(path, at);
			},
			catch: (cause) => RecordingsError.DeleteFailed({ id, cause }),
		}),
};
