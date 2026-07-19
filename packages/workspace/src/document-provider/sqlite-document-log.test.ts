/**
 * SQLite Document Log Tests
 *
 * Verifies owner-side Yjs 14 update-log semantics: transactional append
 * admission with row liveness, bounded fresh-document compaction, capture,
 * and composable durable deletion.
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { SqliteDatabase } from '@epicenter/sqlite';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import * as Y from '@y/y';
import type { RowAddress } from './persistence.js';
import {
	createSqliteDocumentLog,
	isDocumentRowAbsentError,
} from './sqlite-document-log.js';

const LOG_TABLE = 'workspace_document_updates';

function address(rowId: string): RowAddress {
	return { table: 'notes', rowId };
}

function setup({
	compactionThreshold,
	isRowLive = () => true,
}: {
	compactionThreshold?: number;
	isRowLive?: (address: RowAddress) => boolean;
} = {}) {
	const sqlite = new Database(':memory:', { strict: true });
	const database = createBunSqliteAdapter(sqlite);
	return {
		sqlite,
		database,
		log: createSqliteDocumentLog({
			database,
			isRowLive,
			...(compactionThreshold === undefined ? {} : { compactionThreshold }),
		}),
	};
}

function encodeText(text: string): Uint8Array {
	const document = new Y.Doc();
	try {
		document.get('editor').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(document));
	} finally {
		document.destroy();
	}
}

function decodeText(parts: readonly Uint8Array[]): string {
	const document = new Y.Doc();
	try {
		for (const part of parts) Y.applyUpdateV2(document, part);
		return document.get('editor').toString();
	} finally {
		document.destroy();
	}
}

function countUpdates(database: SqliteDatabase, target: RowAddress): number {
	return (
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM ${LOG_TABLE}
			 WHERE table_name = ? AND row_id = ?`,
			[target.table, target.rowId],
		)[0]?.count ?? 0
	);
}

test('append then load replays updates in order across reopen', () => {
	const context = setup();
	try {
		context.log.append(address('written'), encodeText('durable value'));
		expect(decodeText(context.log.load(address('written')))).toBe(
			'durable value',
		);
		expect(context.log.load(address('empty'))).toEqual([]);

		const reopened = createSqliteDocumentLog({
			database: context.database,
			isRowLive: () => true,
		});
		expect(decodeText(reopened.load(address('written')))).toBe(
			'durable value',
		);
	} finally {
		context.sqlite.close();
	}
});

test('append refuses an absent row with the named address-scoped error', () => {
	const live = new Set(['alive']);
	const context = setup({ isRowLive: ({ rowId }) => live.has(rowId) });
	try {
		context.log.append(address('alive'), encodeText('kept'));
		let refusal: unknown;
		try {
			context.log.append(address('deleted'), encodeText('dropped'));
		} catch (cause) {
			refusal = cause;
		}
		expect(isDocumentRowAbsentError(refusal)).toBe(true);
		expect(countUpdates(context.database, address('deleted'))).toBe(0);

		// The refusal is address-scoped: the log stays healthy for live rows.
		context.log.append(address('alive'), encodeText('still kept'));
		expect(context.log.load(address('alive'))).toHaveLength(2);
	} finally {
		context.sqlite.close();
	}
});

test('liveness is read inside the append transaction', () => {
	const live = new Set(['racer']);
	const context = setup({
		isRowLive: ({ rowId }) => live.has(rowId),
	});
	try {
		context.log.append(address('racer'), encodeText('before deletion'));
		// The row dies between the renderer capturing the update and the owner
		// admitting it; the same-transaction read refuses the late append.
		live.delete('racer');
		expect(() =>
			context.log.append(address('racer'), encodeText('late append')),
		).toThrow('absent row');
		expect(decodeText(context.log.load(address('racer')))).toBe(
			'before deletion',
		);
	} finally {
		context.sqlite.close();
	}
});

test('bounded compaction replaces the covered prefix with one compact update', () => {
	const context = setup({ compactionThreshold: 3 });
	try {
		const shared = new Y.Doc();
		try {
			const target = address('compacted');
			for (const character of ['a', 'b', 'c']) {
				shared
					.get('editor')
					.insert(shared.get('editor').length, character);
				context.log.append(
					target,
					new Uint8Array(Y.encodeStateAsUpdateV2(shared)),
				);
			}
			expect(countUpdates(context.database, target)).toBe(1);
			expect(decodeText(context.log.load(target))).toBe('abc');

			// Replacement content compacts back down instead of accreting.
			const replaced = context.log.capture(target);
			expect(replaced).toBeDefined();
			expect(replaced!.byteLength).toBeLessThan(1024);
		} finally {
			shared.destroy();
		}
	} finally {
		context.sqlite.close();
	}
});

test('capture folds durable updates and reports absence as undefined', () => {
	const context = setup();
	try {
		expect(context.log.capture(address('missing'))).toBeUndefined();
		context.log.append(address('captured'), encodeText('captured value'));
		const bytes = context.log.capture(address('captured'));
		expect(decodeText([bytes!])).toBe('captured value');
	} finally {
		context.sqlite.close();
	}
});

test('deleteRows composes into a caller transaction with scalar death', () => {
	const context = setup();
	try {
		context.database.run(
			'CREATE TABLE rows (table_key TEXT, row_id TEXT, PRIMARY KEY(table_key, row_id))',
		);
		context.database.run("INSERT INTO rows VALUES ('notes', 'doomed')");
		context.log.append(address('doomed'), encodeText('to remove'));
		context.log.append(address('survivor'), encodeText('to keep'));

		let failedOnce = false;
		try {
			context.database.transaction(() => {
				context.database.run(
					"DELETE FROM rows WHERE table_key = 'notes' AND row_id = 'doomed'",
				);
				context.log.deleteRows([address('doomed')]);
				throw new Error('injected crash before commit');
			});
		} catch {
			failedOnce = true;
		}
		expect(failedOnce).toBe(true);
		// Scalar and document deletion rolled back together.
		expect(countUpdates(context.database, address('doomed'))).toBe(1);

		context.database.transaction(() => {
			context.database.run(
				"DELETE FROM rows WHERE table_key = 'notes' AND row_id = 'doomed'",
			);
			context.log.deleteRows([address('doomed')]);
		});
		expect(countUpdates(context.database, address('doomed'))).toBe(0);
		expect(decodeText(context.log.load(address('survivor')))).toBe('to keep');
	} finally {
		context.sqlite.close();
	}
});

test('deleteAllRows clears every address inside the caller transaction', () => {
	const context = setup();
	try {
		context.log.append(address('one'), encodeText('1'));
		context.log.append(address('two'), encodeText('2'));
		context.database.transaction(() => {
			context.log.deleteAllRows();
		});
		expect(context.log.load(address('one'))).toEqual([]);
		expect(context.log.load(address('two'))).toEqual([]);
	} finally {
		context.sqlite.close();
	}
});

test('deleted rows cannot be resurrected by a late append', () => {
	const live = new Set(['victim']);
	const context = setup({ isRowLive: ({ rowId }) => live.has(rowId) });
	try {
		context.log.append(address('victim'), encodeText('content'));
		context.database.transaction(() => {
			live.delete('victim');
			context.log.deleteRows([address('victim')]);
		});
		expect(() =>
			context.log.append(address('victim'), encodeText('late')),
		).toThrow('absent row');
		expect(context.log.capture(address('victim'))).toBeUndefined();
	} finally {
		context.sqlite.close();
	}
});

test('corrupt updates poison the log at replay and every later operation', () => {
	const context = setup();
	try {
		context.database.run(
			`INSERT INTO ${LOG_TABLE}(table_name, row_id, update_bytes)
			 VALUES (?, ?, ?)`,
			['notes', 'corrupt', new Uint8Array([255])],
		);
		// Load hands raw bytes to the renderer, which fails closed at apply;
		// owner-side replay (capture, compaction) fails closed here.
		expect(() => context.log.capture(address('corrupt'))).toThrow();
		expect(() => context.log.load(address('healthy'))).toThrow();
		expect(() =>
			context.log.append(address('healthy'), encodeText('refused')),
		).toThrow();
		expect(() => context.log.capture(address('healthy'))).toThrow();
	} finally {
		context.sqlite.close();
	}
});

test('failed append transaction rolls back and poisons the log', () => {
	const sqlite = new Database(':memory:', { strict: true });
	const base = createBunSqliteAdapter(sqlite);
	let failNextTransaction = false;
	const database: SqliteDatabase = {
		run: base.run,
		all: base.all,
		transaction(run) {
			return base.transaction(() => {
				const result = run();
				if (failNextTransaction) {
					failNextTransaction = false;
					throw new Error('injected crash before commit');
				}
				return result;
			});
		},
	};
	try {
		const log = createSqliteDocumentLog({ database, isRowLive: () => true });
		log.append(address('crash-safe'), encodeText('a'));
		failNextTransaction = true;
		expect(() => log.append(address('crash-safe'), encodeText('b'))).toThrow(
			'injected crash before commit',
		);
		expect(() => log.load(address('crash-safe'))).toThrow(
			'injected crash before commit',
		);

		const reopened = createSqliteDocumentLog({
			database: base,
			isRowLive: () => true,
		});
		expect(decodeText(reopened.load(address('crash-safe')))).toBe('a');
	} finally {
		sqlite.close();
	}
});
