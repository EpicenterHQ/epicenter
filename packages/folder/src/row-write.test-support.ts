/** Test support for row writes: the row a write left, where a test knows one stands. */
import type { Result } from 'wellcrafted/result';
import { expectOk } from 'wellcrafted/testing';
import type { RowWriteError } from './errors.js';
import { isStoredRow, type StoredRow, type WrittenRow } from './table.js';

/** The row a write left at its stem; throws when none, or a file that is not a row, is there. */
export function mustRow<TFields>(
	result: Result<WrittenRow<TFields>, RowWriteError>,
): StoredRow<TFields> {
	const written = expectOk(result);
	if (!isStoredRow(written))
		throw new Error(`the write left no row: ${JSON.stringify(written)}`);
	return written;
}
