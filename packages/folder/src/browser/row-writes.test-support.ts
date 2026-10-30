/**
 * A row change over the browser engine's raw files, for engine tests and
 * smoke clients that drive the repository without a `Folder`. The `Folder`
 * composes row changes through its serial queue; the engine only
 * stores whole files.
 */

import type { TSchema } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { SaveError } from '../shared/errors.js';
import { changeMarkdown, readMarkdown } from '../shared/markdown-codec.js';
import { type Row, type RowChange, readRow } from '../shared/row.js';
import type { LocalRepository } from './repository.js';
import { anyFields } from './repository.test-support.js';
import { snapshotContent } from './storage.js';

/**
 * Apply `change` to row `id` of `table` as it is stored now, and store it.
 * Answers the row read through `schema`.
 */
export async function writeRow<TRowSchema extends TSchema>(
	repository: LocalRepository,
	table: string,
	id: string,
	change: RowChange,
	schema: TRowSchema,
): Promise<Result<Row<TRowSchema>, SaveError>> {
	const path = `${table}/${id}.md`;
	const content = snapshotContent(
		await repository.storage.capture([path]),
		path,
	);
	const current = content === null ? null : readMarkdown(content, anyFields);
	if (current?.issues?.some((issue) => issue.kind === 'not-text'))
		return SaveError.NotText();
	const changed = changeMarkdown(current, change);
	if (changed.error !== null)
		return SaveError.Unparseable({ reason: changed.error.reason });
	const written = await repository.put(path, changed.data.text);
	if (written.error !== null) return Err(written.error);
	return Ok(readRow(id, changed.data.text, schema));
}
