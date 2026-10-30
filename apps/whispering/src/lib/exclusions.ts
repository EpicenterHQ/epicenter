import type { ReadError, WriteError } from '@epicenter/folder';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Err, Ok, type Result, trySync } from 'wellcrafted/result';
import type { WhisperingFolder } from './folder.js';

const MARKDOWN_RULES = ['*', '!*/', '!*.md', '!.gitignore'];

/** Comments and empty lines do not interrupt the ordered default block. */
function hasMarkdownRules(text: string) {
	const active = text
		.replace(/^\ufeff/, '')
		.split(/\r?\n/)
		.filter((line) => line !== '' && !line.startsWith('#'));
	return active.some((_, index) =>
		MARKDOWN_RULES.every((rule, offset) => active[index + offset] === rule),
	);
}

const ExclusionError = defineErrors({
	InvalidIgnoreText: () => ({
		message: '.gitignore is not UTF-8 text. Its bytes were left unchanged.',
	}),
	MissingRules: () => ({
		message:
			'.gitignore changed during startup and no longer contains the Markdown-only defaults.',
	}),
});
type ExclusionError = InferErrors<typeof ExclusionError>;

/** Read without losing a BOM or silently replacing invalid UTF-8. */
async function readRules(folder: Pick<WhisperingFolder, 'read'>) {
	const loaded = await folder.read('.gitignore');
	if (loaded.error !== null) return loaded;
	const before = loaded.data;
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
 * Maintain Markdown-only Git defaults through ordinary file saves.
 * Existing text follows the defaults so authored rules can override them.
 * An already-installed block stays where it is.
 * No Git commit, startup marker, or separate policy is created.
 */
export async function maintainExclusions(
	folder: Pick<WhisperingFolder, 'read' | 'write'>,
): Promise<Result<void, ReadError | WriteError | ExclusionError>> {
	const read = await readRules(folder);
	if (read.error !== null) return Err(read.error);
	const { text } = read.data;
	if (hasMarkdownRules(text)) return Ok(undefined);
	const newline = text.includes('\r\n') ? '\r\n' : '\n';
	const bom = text.startsWith('\ufeff') ? '\ufeff' : '';
	const saved = await folder.write(
		'.gitignore',
		`${bom}${MARKDOWN_RULES.join(newline)}${newline}${text.slice(bom.length)}`,
	);
	if (saved.error !== null) return saved;

	// Confirm the published block is still present after the write.
	const verified = await readRules(folder);
	if (verified.error !== null) return Err(verified.error);
	if (!hasMarkdownRules(verified.data.text))
		return ExclusionError.MissingRules();
	return Ok(undefined);
}
