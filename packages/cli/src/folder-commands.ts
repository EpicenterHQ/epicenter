/**
 * `query`: a legacy data folder's tables, read through its `epicenter.json`,
 * as text for a person or JSON for a program (ADR-0520). The reading and the
 * projection live in `@epicenter/folder/bun`. `check` and `format` take an
 * app's contract instead (`contract-commands.ts`).
 */

import {
	checkFolder,
	describeTables,
	queryFolder,
} from '@epicenter/folder/bun';
import { count, EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/** Check a folder, or end the command when it cannot be read as one. */
async function checked(dir: string, json: boolean) {
	const { data, error } = await checkFolder(dir);
	if (error === null) return data;
	fail(error.message, json);
	return undefined;
}

/**
 * Rows as tab-separated text with a header. Backslash, tab, newline, and
 * carriage return are escaped, so every row is one line and splits exactly.
 */
function formatRows(columns: string[], rows: Record<string, unknown>[]) {
	const cell = (value: unknown) =>
		value === null || value === undefined
			? ''
			: String(value)
					.replaceAll('\\', '\\\\')
					.replaceAll('\t', '\\t')
					.replaceAll('\n', '\\n')
					.replaceAll('\r', '\\r');
	return [
		columns.join('\t'),
		...rows.map((row) => columns.map((column) => cell(row[column])).join('\t')),
	].join('\n');
}

export async function query(
	dir: string,
	sql: string | undefined,
	json: boolean,
) {
	const folder = await checked(dir, json);
	if (folder === undefined) return EXIT.unusable;
	if (sql === undefined) {
		const tables = describeTables(folder.tables);
		if (json) writeJson({ tables });
		else
			writeOut(
				tables
					.flatMap((table) => [
						`${table.name}:`,
						...table.columns.map(({ name, values }) => `  ${name}: ${values}`),
					])
					.join('\n'),
			);
		return EXIT.ok;
	}
	const { data: answer, error } = queryFolder(folder, sql);
	if (error !== null) return fail(error.message, json);
	const { columns, rows, excluded } = answer;
	if (json) {
		writeJson({ columns, rows, excluded });
		return EXIT.ok;
	}
	writeOut(formatRows(columns, rows));
	if (excluded.length)
		writeErr(
			`${count(excluded.length, 'file')} excluded because ${excluded.length === 1 ? 'it does' : 'they do'} not conform: ${excluded.join(', ')}`,
		);
	return EXIT.ok;
}
