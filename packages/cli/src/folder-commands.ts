/**
 * `check`, `query`, and `generate`: what `@epicenter/folder/bun` reports, as
 * text for a person or JSON for a program (ADR-0520, ADR-0527). The reading,
 * the projection, and running `epicenter.ts` all live in the folder package.
 */

import {
	checkFolder,
	DEFINITION_PATH,
	DEFINITION_SOURCE_PATH,
	describeTables,
	type Finding,
	generateDefinition,
	hasDefinitionSource,
	queryFolder,
} from '@epicenter/folder/bun';
import { count, EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';

/**
 * `path:line: message`, compiler style. The message already names its field,
 * so the field stays in `--json` rather than the text.
 */
function formatFinding({ path, line, message }: Finding) {
	return `${line === undefined ? path : `${path}:${line}`}: ${message}`;
}

/** Files with at least one finding, so a row with three issues counts once. */
function fileCount(findings: Finding[]) {
	return new Set(findings.map(({ path }) => path)).size;
}

/** Check a folder, or end the command when it cannot be read as one. */
async function checked(dir: string, json: boolean) {
	const { data, error } = await checkFolder(dir);
	if (error === null) return data;
	fail(
		error.name === 'NotDataFolder' && hasDefinitionSource(dir)
			? `${error.message}; run \`epicenter generate ${dir}\` to write it from ${DEFINITION_SOURCE_PATH}`
			: error.message,
		json,
	);
	return undefined;
}

export async function check(dir: string, json: boolean) {
	const folder = await checked(dir, json);
	if (folder === undefined) return EXIT.unusable;
	const { rows, invalid, unreadable, hasSource } = folder;
	const exitCode = unreadable.length
		? EXIT.unusable
		: invalid.length
			? EXIT.finding
			: EXIT.ok;
	if (json) {
		writeJson({
			rows,
			invalid,
			unreadable,
			exitCode,
			...(hasSource ? { source: DEFINITION_SOURCE_PATH } : {}),
		});
		return exitCode;
	}
	if (hasSource)
		writeErr(
			`${DEFINITION_PATH} is generated from ${DEFINITION_SOURCE_PATH}; edit the .ts and run \`epicenter generate ${dir}\`, not the .json.`,
		);
	writeOut(
		[
			...unreadable.map(formatFinding),
			...invalid.map(formatFinding),
			`${count(rows, 'row')} ${rows === 1 ? 'conforms' : 'conform'}; ${count(fileCount(invalid), 'file')} invalid; ${unreadable.length} unreadable.`,
		].join('\n'),
	);
	return exitCode;
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
			`${count(excluded.length, 'file')} excluded because ${excluded.length === 1 ? 'it does' : 'they do'} not conform: ${excluded.join(', ')}. Run \`epicenter check ${dir}\``,
		);
	return EXIT.ok;
}

export async function generate(dir: string, json: boolean) {
	const { data, error } = await generateDefinition(dir);
	if (error !== null) return fail(error.message, json);
	if (json)
		writeJson({
			written: data.written,
			path: DEFINITION_PATH,
			source: DEFINITION_SOURCE_PATH,
		});
	else
		writeOut(
			`${data.written ? 'wrote' : 'unchanged'} ${DEFINITION_PATH} from ${DEFINITION_SOURCE_PATH}`,
		);
	return EXIT.ok;
}
