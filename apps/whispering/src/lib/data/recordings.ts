/**
 * Recordings, in `recordings/`. A recording is two files by id: its audio,
 * `<id>.webm` from the desktop recorder or `<id>.m4a` from Safari's, and its
 * note, `<id>.md`, whose front matter holds `durationMs` and whose body is
 * the transcript: the text the person got. When cleanup changed that text,
 * front matter also holds `original`, the server's own words. Either file
 * can be missing: a take that crashed before its note
 * was written is audio alone. Its time is in its id (`recordedAt` in
 * `feed.ts`), so the note does not repeat it.
 *
 * The audio belongs to the recording: it is made with it, has its id, and
 * is deleted with it, so this module owns both files.
 */
import { changeMarkdown, readMarkdown } from '@epicenter/app/markdown';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { recordedAt } from '../feed';
import { files } from '../platform';

const DIR = 'recordings';
/** The extensions a recording's audio may have. */
const AUDIO = ['webm', 'm4a'] as const;

const notePath = (id: string) => `${DIR}/${id}.md`;

/** A recording. */
export type Recording = {
	id: string;
	/** When it was made, read from its id, so audio with no note still has a time. */
	at: Date | undefined;
	durationMs: number | undefined;
	/** The text the person got: the transcript after cleanup, when it ran. */
	transcript: string;
	/** What the transcription server wrote, when cleanup changed it; undefined otherwise. */
	original: string | undefined;
	/** The path of its audio, when it has any. */
	audio: string | undefined;
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

/** The id and kind of a file in `recordings/`, or undefined for a file that is neither a note nor audio. */
function parseName(name: string) {
	const dot = name.lastIndexOf('.');
	const id = name.slice(0, dot);
	const extension = name.slice(dot + 1);
	if (dot <= 0) return undefined;
	if (extension === 'md') return { id, kind: 'note' as const };
	if ((AUDIO as readonly string[]).includes(extension))
		return { id, kind: 'audio' as const };
	return undefined;
}

export const recordings = {
	/** Every recording, oldest first (ids sort by time). One read for every note. */
	async list() {
		const listed = await files.list(DIR);
		if (listed.error)
			return RecordingsError.ListFailed({ cause: listed.error });
		const byId = new Map<string, { note: boolean; audio?: string }>();
		for (const name of listed.data) {
			const parsed = parseName(name);
			if (!parsed) continue;
			const entry = byId.get(parsed.id) ?? { note: false };
			if (parsed.kind === 'note') entry.note = true;
			else entry.audio = `${DIR}/${name}`;
			byId.set(parsed.id, entry);
		}
		const notes = await files.readMany(
			[...byId].filter(([, entry]) => entry.note).map(([id]) => notePath(id)),
		);
		if (notes.error) return RecordingsError.ListFailed({ cause: notes.error });
		return Ok(
			[...byId]
				.sort(([a], [b]) => (a < b ? -1 : 1))
				.map(([id, { audio }]): Recording => {
					const { fields, body } = readMarkdown(
						notes.data.get(notePath(id)) ?? '',
					);
					return {
						id,
						at: recordedAt(id),
						durationMs:
							typeof fields.durationMs === 'number'
								? fields.durationMs
								: undefined,
						transcript: body.trim(),
						original:
							typeof fields.original === 'string' ? fields.original : undefined,
						audio,
					};
				}),
		);
	},

	/** A URL an `<audio>` element plays the recording `id`'s audio at `audio` from. */
	async audioUrl(id: string, audio: string) {
		const url = await files.url(audio);
		if (url.error) return RecordingsError.ReadFailed({ id, cause: url.error });
		return url;
	},

	/**
	 * Write the note of the recording `id`: its length, and its transcript
	 * when there is one. After a take, the recorder has already written the
	 * audio beside it.
	 */
	async add({
		id,
		durationMs,
		transcript = '',
	}: {
		id: string;
		durationMs: number;
		transcript?: string;
	}) {
		const written = await files.write(
			notePath(id),
			changeMarkdown('', {
				set: { durationMs },
				body: transcript ? `${transcript}\n` : '',
			}),
		);
		if (written.error)
			return RecordingsError.WriteFailed({ id, cause: written.error });
		return written;
	},

	/**
	 * Replace the transcript of the recording `id`, keeping every other front
	 * matter line as it is. A recording with audio and no note gets one.
	 *
	 * `original` is what the server wrote. Given, it is kept when cleanup
	 * changed the text and removed when it did not, so a transcript never
	 * carries an older take's original. Not given, as in an edit by hand, the
	 * original stays as it is.
	 */
	async setTranscript({
		id,
		transcript,
		original,
	}: {
		id: string;
		transcript: string;
		original?: string;
	}) {
		const read = await files.readMany([notePath(id)]);
		if (read.error)
			return RecordingsError.ReadFailed({ id, cause: read.error });
		const changed = original !== undefined && original !== transcript;
		const written = await files.write(
			notePath(id),
			changeMarkdown(read.data.get(notePath(id)) ?? '', {
				set: changed ? { original } : {},
				removed: original !== undefined && !changed ? ['original'] : [],
				body: transcript ? `${transcript}\n` : '',
			}),
		);
		if (written.error)
			return RecordingsError.WriteFailed({ id, cause: written.error });
		return written;
	},

	/** Delete the recording's note and audio, whichever are there. */
	async delete({ id }: { id: string }) {
		for (const path of [
			notePath(id),
			...AUDIO.map((ext) => `${DIR}/${id}.${ext}`),
		]) {
			const removed = await files.remove(path);
			if (removed.error)
				return RecordingsError.DeleteFailed({ id, cause: removed.error });
		}
		return Ok(undefined);
	},
};
