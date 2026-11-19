/**
 * Recordings on disk, in `recordings/` in the app's local data directory:
 * `<id>.webm` is the audio the native recorder wrote, and `<id>.md` is the
 * note, whose front matter holds `durationMs` and whose body is the
 * transcript. A recording is the two files by id; either can be missing.
 * Its time is in its id (`recordedAt` in `feed.ts`), so the note does not
 * repeat it.
 *
 * A note is written whole (`writeWhole` in `files.ts`), so a crash mid-write
 * leaves the old note whole.
 */
import { changeMarkdown, readMarkdown } from '@epicenter/app/markdown';
import { convertFileSrc, invoke } from '@tauri-apps/api/core';
import { appLocalDataDir, join } from '@tauri-apps/api/path';
import { exists, readTextFile, remove } from '@tauri-apps/plugin-fs';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { tryAsync } from 'wellcrafted/result';
import { recordedAt } from './feed';
import { appData, writeWhole } from './files';

/** A recording. */
export type Recording = {
	id: string;
	/** When it was made, read from its id, so audio with no note still has a time. */
	at: Date | undefined;
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

const notePath = (id: string) => `recordings/${id}.md`;
const audioPath = (id: string) => `recordings/${id}.webm`;

/** What `recordings_list` answers for each id. */
type Listed = { id: string; note: string | null; audio: boolean };

function toRecording({ id, note, audio }: Listed): Recording {
	const { fields, body } = readMarkdown(note ?? '');
	return {
		id,
		at: recordedAt(id),
		durationMs:
			typeof fields.durationMs === 'number' ? fields.durationMs : undefined,
		transcript: body.trim(),
		audio,
	};
}

export const recordings = {
	/** Every recording, oldest first (ids sort by time). One call reads every note. */
	list: () =>
		tryAsync({
			try: async () =>
				(await invoke<Listed[]>('recordings_list')).map(toRecording),
			catch: (cause) => RecordingsError.ListFailed({ cause }),
		}),

	/**
	 * A URL an `<audio>` element plays the recording `id` from. On the desktop
	 * it is the file itself through Tauri's asset protocol, which streams it
	 * and seeks without reading it all; `main.rs` lets that protocol read
	 * `recordings/` and nothing else.
	 */
	audioUrl: (id: string) =>
		tryAsync({
			try: async () =>
				convertFileSrc(
					await join(await appLocalDataDir(), 'recordings', `${id}.webm`),
				),
			catch: (cause) => RecordingsError.ReadFailed({ id, cause }),
		}),

	/** Write the note for a take the recorder just finished: its time and length, no transcript yet. */
	addNote: ({ id, durationMs }: { id: string; durationMs: number }) =>
		tryAsync({
			try: () =>
				writeWhole(
					notePath(id),
					changeMarkdown('', { set: { durationMs }, body: '' }),
				),
			catch: (cause) => RecordingsError.WriteFailed({ id, cause }),
		}),

	/**
	 * Replace the transcript of the recording `id`, keeping every front
	 * matter line as it is. A recording with audio and no note gets one.
	 */
	setTranscript: ({ id, transcript }: { id: string; transcript: string }) =>
		tryAsync({
			try: async () => {
				const before = (await exists(notePath(id), appData))
					? await readTextFile(notePath(id), appData)
					: '';
				await writeWhole(
					notePath(id),
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
					if (await exists(path, appData)) await remove(path, appData);
			},
			catch: (cause) => RecordingsError.DeleteFailed({ id, cause }),
		}),
};
