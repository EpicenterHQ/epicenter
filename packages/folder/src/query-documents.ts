/** Read-only SQL over the generic editor's saved Markdown interpretation. */
import type { DocumentReading } from './documents.js';
import { queryProjection } from './query-folder.js';

/**
 * A stable relation avoids inventing column types from whichever files were
 * read first. JSON fields retain arbitrary keys, nested values, and casing.
 * Malformed readable documents remain queryable with their issues.
 */
export function queryDocuments(reading: DocumentReading, sql: string) {
	const result = queryProjection(
		sql,
		(db) => {
			db.run(
				'CREATE TABLE documents (path TEXT PRIMARY KEY, directory TEXT, stem TEXT, fields TEXT, body TEXT, issues TEXT)',
			);
			const insert = db.prepare(
				'INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?)',
			);
			db.transaction(() => {
				for (const doc of reading.documents) {
					if (doc.issues?.some((issue) => issue.kind === 'not-text')) continue;
					insert.run(
						doc.path,
						doc.directory,
						doc.stem,
						JSON.stringify(doc.fields ?? null),
						doc.body ?? null,
						JSON.stringify(doc.issues ?? []),
					);
				}
			})();
			db.run('PRAGMA query_only = ON');
		},
		[
			...reading.unreadable.map(({ path }) => path),
			...reading.documents
				.filter((doc) => doc.issues?.some((issue) => issue.kind === 'not-text'))
				.map(({ path }) => path),
		],
		{ rows: 1000, bytes: 4 * 1024 * 1024 },
	);
	if (result.error !== null) return result;
	return {
		...result,
		data: {
			...result.data,
			warnings:
				reading.declarationProblem === undefined
					? []
					: [reading.declarationProblem],
		},
	};
}
