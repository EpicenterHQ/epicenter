/** Explicitly export an app's TypeBox table schemas as portable JSON data. */
import type { TSchema } from 'typebox';
import { Err, Ok } from 'wellcrafted/result';
import { readTableSchemas } from './declaration.js';
import { schemaSourceProblem } from './schema-source.js';

/** This does not open a folder or publish schemas into one. */
export function exportTables(tables: Record<string, TSchema>) {
	try {
		const problem = schemaSourceProblem(tables);
		if (problem !== undefined) return Err({ reason: problem });
		const portable = readTableSchemas(JSON.parse(JSON.stringify(tables)));
		if (portable.error !== null) return portable;
		return portable.data === undefined
			? Err({ reason: 'Table schemas must be an object' })
			: Ok({ tables: portable.data });
	} catch (cause) {
		return Err({
			reason: cause instanceof Error ? cause.message : String(cause),
		});
	}
}
