import {
	inRun,
	type QueryParams,
	type QueryValue,
	query,
	queryTables,
} from '@epicenter/app';
import { misuse, parseWords } from './commands.js';
import { CliError } from './errors.js';
import { loadHomeApp } from './home.js';
import { fail, presentAnswer, writeJson, writeOut } from './output.js';

/** Read an app's collections in this process, without a write, lock, or commit. */
export async function queryCommand(
	words: string[],
	json: boolean,
): Promise<number> {
	const given = parseWords(words, { params: { type: 'string' } }, [1, 2]);
	if (!given) return fail(misuse('query'), json);
	const [name, sql] = given.positionals as [string, string?];
	if (given.values.params !== undefined && sql === undefined)
		return fail(misuse('query', '--params needs <sql>'), json);
	const { data: located, error } = await loadHomeApp(name);
	if (error) return fail(error, json);
	if (!located.ok)
		return fail(
			CliError.AppProblems({ app: name, problems: located.problems }).error,
			json,
		);
	let params: QueryParams | undefined;
	if (given.values.params !== undefined) {
		try {
			const value: unknown = JSON.parse(given.values.params);
			const scalar = (item: unknown): item is QueryValue =>
				item === null || ['string', 'number', 'boolean'].includes(typeof item);
			if (
				value === null ||
				typeof value !== 'object' ||
				!Object.values(value).every(scalar)
			)
				throw new Error('invalid params');
			params = value as QueryParams;
		} catch {
			return fail(
				misuse(
					'query',
					'--params must be a JSON array or object of strings, numbers, booleans, or null',
				),
				json,
			);
		}
	}
	if (sql === undefined) {
		const tables = queryTables(located.app.collections);
		if (json) writeJson(tables);
		else
			writeOut(
				tables.length
					? tables
							.map(
								({ table, path, columns }) =>
									`${table}  ${path}\n  ${columns.map(({ name, type }) => `${name} ${type}`).join(', ')}`,
							)
							.join('\n\n')
					: `${name} has no tables`,
			);
		return 0;
	}
	try {
		const rows = await inRun(
			{ ...located.context, readOnly: { action: 'query' } },
			() => query(located.app.collections, sql, params),
		);
		if (json) {
			writeJson(rows);
			return 0;
		}
		return presentAnswer({ returned: rows }, false);
	} catch (error) {
		if (
			typeof error === 'object' &&
			error !== null &&
			'name' in error &&
			'message' in error &&
			typeof error.message === 'string'
		) {
			if (error.name === 'Refused')
				return fail(
					CliError.Refused({
						message: error.message,
						next: 'epicenter query --help',
					}).error,
					json,
				);
			if (error.name === 'Failed')
				return fail(
					CliError.Usage({
						message: error.message,
						next: `epicenter query ${name}`,
					}).error,
					json,
				);
		}
		throw error;
	}
}
