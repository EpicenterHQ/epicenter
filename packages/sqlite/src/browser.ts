import type { SqliteDatabase, SqliteRow, SqliteValue } from './index.js';

export type BrowserSqliteDatabase = {
	exec(options: {
		sql: string;
		bind?: readonly SqliteValue[];
		rowMode?: 'object';
		resultRows?: unknown[];
	}): unknown;
	transaction<TResult>(
		beginQualifier: 'DEFERRED' | 'IMMEDIATE',
		run: () => TResult,
	): TResult;
};

/** Adapt sqlite.org's OO1 browser API without importing a WASM implementation. */
export function createBrowserSqliteAdapter(
	database: BrowserSqliteDatabase,
): SqliteDatabase {
	let transactionDepth = 0;
	let savepointSequence = 0;

	function invoke<TResult>(run: () => TResult): TResult {
		transactionDepth += 1;
		try {
			return run();
		} finally {
			transactionDepth -= 1;
		}
	}

	function transaction<TResult>(
		qualifier: 'DEFERRED' | 'IMMEDIATE',
		run: () => TResult,
	): TResult {
		if (transactionDepth === 0) {
			return database.transaction(qualifier, () => invoke(run));
		}

		const savepoint = `epicenter_nested_${savepointSequence++}`;
		database.exec({ sql: `SAVEPOINT ${savepoint}` });
		try {
			const result = invoke(run);
			database.exec({ sql: `RELEASE ${savepoint}` });
			return result;
		} catch (cause) {
			database.exec({ sql: `ROLLBACK TO ${savepoint}` });
			database.exec({ sql: `RELEASE ${savepoint}` });
			throw cause;
		}
	}

	return {
		run(sql, parameters = []): void {
			database.exec({ sql, bind: parameters });
		},
		all<TRow extends SqliteRow>(sql: string, parameters = []): TRow[] {
			const resultRows: unknown[] = [];
			database.exec({
				sql,
				bind: parameters,
				rowMode: 'object',
				resultRows,
			});
			return resultRows as TRow[];
		},
		readTransaction<TResult>(run: () => TResult): TResult {
			return transaction('DEFERRED', run);
		},
		transaction<TResult>(run: () => TResult): TResult {
			return transaction('IMMEDIATE', run);
		},
	};
}
