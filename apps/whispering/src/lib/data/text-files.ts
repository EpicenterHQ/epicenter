/**
 * The text files a person edits beside `settings.json`, by path:
 *
 * - `dictionary.txt`: words to spell as written, and `heard -> written`
 *   replacements (`cleanup.ts` reads it).
 * - `cleanup.md`: the person's own cleanup prompt, as plain prose.
 *
 * A missing file reads as null, and the reader decides what stands in for
 * it: an empty dictionary, or the built-in prompt, which improves with each
 * release. Removing the file goes back to that.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { files } from '../platform';

export const DICTIONARY = 'dictionary.txt';
export const CLEANUP_PROMPT = 'cleanup.md';

export const TextFileError = defineErrors({
	ReadFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `${path} could not be read: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
	WriteFailed: ({ path, cause }: { path: string; cause: unknown }) => ({
		message: `${path} could not be saved: ${extractErrorMessage(cause)}`,
		path,
		cause,
	}),
});
export type TextFileError = InferErrors<typeof TextFileError>;

export const textFiles = {
	/** The text at `path`, or null when there is none (a query's data cannot be undefined). */
	async read(path: string) {
		const read = await files.readMany([path]);
		if (read.error)
			return TextFileError.ReadFailed({ path, cause: read.error });
		return Ok(read.data.get(path) ?? null);
	},

	/** Replace the text at `path` with `text`, ending in one newline. */
	async write({ path, text }: { path: string; text: string }) {
		const written = await files.write(path, `${text.trimEnd()}\n`);
		if (written.error)
			return TextFileError.WriteFailed({ path, cause: written.error });
		return Ok(undefined);
	},

	/** Delete the file at `path`, so its reader falls back. */
	async remove({ path }: { path: string }) {
		const removed = await files.remove(path);
		if (removed.error)
			return TextFileError.WriteFailed({ path, cause: removed.error });
		return Ok(undefined);
	},
};
