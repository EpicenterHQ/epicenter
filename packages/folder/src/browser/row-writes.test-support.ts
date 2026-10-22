/**
 * A row change over the browser engine's raw files, for engine tests and
 * smoke clients that drive the repository without a `Folder`. The `Folder`
 * composes row changes through its path owner (`handle.ts`); the engine only
 * stores whole files.
 */
import { type TSchema, Type } from 'typebox';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { SaveError } from '../shared/errors.js';
import { changeMarkdown, readMarkdown } from '../shared/markdown-codec.js';
import { type Row, type RowChange, readRow } from '../shared/row.js';
import type { LocalRepository } from './repository.js';

const anyFields = Type.Record(Type.String(), Type.Unknown());

/**
 * Apply `change` to row `id` of `table` as it is stored now, and store it.
 * Answers the row read through `schema`.
 */
export async function writeRow<TRowSchema extends TSchema = typeof anyFields>(
	repository: Pick<LocalRepository, 'files'>,
	table: string,
	id: string,
	change: RowChange,
	schema: TRowSchema = anyFields as unknown as TRowSchema,
): Promise<Result<Row<TRowSchema>, SaveError>> {
	const path = `${table}/${id}.md`;
	const read = await repository.files.read(path);
	if (read.error !== null)
		return SaveError.StorageFailed({ cause: read.error });
	const current =
		read.data === undefined
			? null
			: readMarkdown(
					new Uint8Array(await read.data.content.arrayBuffer()),
					anyFields,
				);
	if (current?.issues?.some((issue) => issue.kind === 'not-text'))
		return SaveError.NotText();
	const changed = changeMarkdown(current, change);
	if (changed.error !== null)
		return SaveError.Unparseable({ reason: changed.error.reason });
	const written = await repository.files.write(path, changed.data.text);
	if (written.error !== null) return Err(written.error);
	return Ok(readRow(id, changed.data.text, schema));
}
