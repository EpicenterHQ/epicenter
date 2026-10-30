/**
 * `checkContract`: whether a folder's files fit a contract, file by file.
 * This is what `epicenter check <contract> [dir]` runs; it reads no disk, so
 * the CLI lists the folder and passes each path, with the text of each note.
 */
import { Ok, type Result } from 'wellcrafted/result';
import { parseRowSource } from '../note/canonical.js';
import { type ContractError, compileContract } from './contract.js';
import { isHiddenPath, isNotePath } from './storage.js';
import { isFilePath } from './templates.js';

/** One reason a file does not fit the contract, located like a compiler diagnostic. */
export type FileIssue = {
	path: string;
	/** The collection that claims the path, when one does. */
	collection?: string;
	/** The front matter key involved, when there is one. */
	field?: string;
	/** The 1-based line in the note's text, when the issue has one. */
	line?: number;
	message: string;
};

/**
 * Check `files` against `contract` (from code or parsed JSON). The contract
 * itself is checked first, and a contract that is not well formed is the
 * error. Otherwise every issue is listed, in the order the files were given:
 *
 * - a path no collection claims (a note path only by a note collection, any
 *   other only by a file collection);
 * - a note whose front matter does not parse to exact JSON values;
 * - a note whose fields do not fit its collection's JSON Schema, or that
 *   lacks a required one. A key the contract does not declare is fine.
 *
 * A path with a hidden segment (`.gitattributes`, `.obsidian/…`,
 * `.epicenter/…`) is not the contract's and is skipped. A note given
 * without `text` is checked by its path alone.
 *
 * @example
 * ```ts
 * const issues = checkContract(recorder, [
 *   { path: 'recordings/a.md', text: '---\ntitle: Standup\n---\n' },
 *   { path: 'recordings/a.webm' },
 * ]);
 * // Ok([])
 * ```
 */
export function checkContract(
	contract: unknown,
	files: Iterable<{ path: string; text?: string }>,
): Result<FileIssue[], ContractError> {
	const compiled = compileContract(contract);
	if (compiled.error !== null) return compiled;
	const issues: FileIssue[] = [];
	for (const { path, text } of files) {
		if (isHiddenPath(path)) continue;
		if (!isFilePath(path)) {
			issues.push({ path, message: 'The path is not a usable file path' });
			continue;
		}
		const claimed = compiled.data.claim(path);
		if (claimed === null) {
			issues.push({
				path,
				message: `No ${isNotePath(path) ? 'note' : 'file'} collection of this contract names this path`,
			});
			continue;
		}
		const { collection } = claimed;
		if (collection.kind === 'file' || text === undefined) continue;
		const parsed = parseRowSource(text);
		if (parsed.error !== null) {
			issues.push({
				path,
				collection: collection.name,
				...(parsed.error.field === undefined
					? {}
					: { field: parsed.error.field }),
				...(parsed.error.line === undefined ? {} : { line: parsed.error.line }),
				message: parsed.error.reason,
			});
			continue;
		}
		for (const issue of collection.checkFields(parsed.data.document.fields)) {
			const line = parsed.data.lineOf(issue.field, issue.path);
			issues.push({
				path,
				collection: collection.name,
				field: issue.field,
				...(line === undefined ? {} : { line }),
				message: issue.message,
			});
		}
	}
	return Ok(issues);
}
