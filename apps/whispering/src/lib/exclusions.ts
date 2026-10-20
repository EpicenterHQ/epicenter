import type { FolderFiles, ReadError, SaveError } from '@epicenter/folder';
import ignore from 'ignore';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import { AUDIO } from './definition.js';

const ExclusionError = defineErrors({
	InvalidIgnoreText: () => ({
		message: '.gitignore is not UTF-8 text. Its bytes were left unchanged.',
	}),
	NotExcluded: () => ({
		message: '.gitignore changed during startup and does not exclude audio/.',
	}),
});
type ExclusionError = InferErrors<typeof ExclusionError>;

/** Read without losing a BOM or silently replacing invalid UTF-8. */
async function readRules(files: Pick<FolderFiles, 'read'>) {
	const loaded = await files.read('.gitignore');
	if (loaded.error !== null) return loaded;
	const before =
		loaded.data === undefined
			? null
			: new Uint8Array(await loaded.data.content.arrayBuffer());
	if (before?.includes(0)) return ExclusionError.InvalidIgnoreText();
	const decoded = trySync({
		try: () =>
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
				before ?? undefined,
			),
		catch: () => ExclusionError.InvalidIgnoreText(),
	});
	if (decoded.error !== null) return decoded;
	return Ok({ before, text: decoded.data });
}

/**
 * Maintain Whispering's root audio exclusion through ordinary file saves.
 * Existing rules stay in order. A later positive directory rule overrides an
 * earlier exception, and excluding the directory excludes all its children.
 * No Git commit, startup marker, or separate policy is created.
 */
export async function maintainExclusions(
	files: Pick<FolderFiles, 'read' | 'write'>,
): Promise<Result<void, ReadError | SaveError | ExclusionError>> {
	const read = await readRules(files);
	if (read.error !== null) return Err(read.error);
	const { before, text } = read.data;
	if (ignore({ ignorecase: false }).add(text).ignores(`${AUDIO}/`))
		return Ok(undefined);
	const newline = text.includes('\r\n') ? '\r\n' : '\n';
	const separator = text === '' || text.endsWith('\n') ? '' : newline;
	const saved = await files.write(
		'.gitignore',
		before,
		`${text}${separator}/${AUDIO}/${newline}`,
	);
	if (saved.error !== null) return saved;

	// A save confirms merged bytes, not the meaning of the requested rules.
	const verified = await readRules(files);
	if (verified.error !== null) return Err(verified.error);
	if (
		!ignore({ ignorecase: false }).add(verified.data.text).ignores(`${AUDIO}/`)
	)
		return ExclusionError.NotExcluded();
	return Ok(undefined);
}
