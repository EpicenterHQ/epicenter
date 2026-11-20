/**
 * Cleanup's two files, beside `settings.json`:
 *
 * - `dictionary.txt`: words to spell as written, and `heard -> written`
 *   replacements (`cleanup.ts` reads it).
 * - `cleanup.md`: the person's own cleanup prompt, as plain prose. When it
 *   is not there, cleanup uses the built-in one, which improves with each
 *   release; resetting deletes the file.
 *
 * Neither is required: a missing dictionary is an empty one.
 */
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { Ok } from 'wellcrafted/result';
import { files } from '../platform';

const DICTIONARY = 'dictionary.txt';
const PROMPT = 'cleanup.md';

export const CleanupError = defineErrors({
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
export type CleanupError = InferErrors<typeof CleanupError>;

/** The text of `path`, or undefined when it is not there. */
async function readText(path: string) {
	const read = await files.readMany([path]);
	if (read.error) return CleanupError.ReadFailed({ path, cause: read.error });
	return Ok(read.data.get(path));
}

/** Write `text` to `path`, ending in one newline. */
async function writeText(path: string, text: string) {
	const written = await files.write(path, `${text.trimEnd()}\n`);
	if (written.error)
		return CleanupError.WriteFailed({ path, cause: written.error });
	return Ok(undefined);
}

export const dictionary = {
	/** The dictionary's text; empty when there is none. */
	async read() {
		const read = await readText(DICTIONARY);
		if (read.error) return read;
		return Ok(read.data ?? '');
	},

	/** Replace the dictionary with `text`. */
	write: ({ text }: { text: string }) => writeText(DICTIONARY, text),
};

export const cleanupPrompt = {
	/**
	 * The person's prompt, or null when cleanup uses the built-in one (a
	 * query's data cannot be undefined).
	 */
	async read() {
		const read = await readText(PROMPT);
		if (read.error) return read;
		return Ok(read.data ?? null);
	},

	/** Replace the person's prompt with `text`. */
	write: ({ text }: { text: string }) => writeText(PROMPT, text),

	/** Go back to the built-in prompt by deleting the person's. */
	async reset() {
		const removed = await files.remove(PROMPT);
		if (removed.error)
			return CleanupError.WriteFailed({ path: PROMPT, cause: removed.error });
		return Ok(undefined);
	},
};
