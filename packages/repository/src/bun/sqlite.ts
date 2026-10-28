/** The `bun:sqlite` driver. */
import { Database } from 'bun:sqlite';
import type { SqlDriver, SqlValue } from '../sql.js';

/** The quote that closes each opening quote of a string or a name. */
const CLOSING: Record<string, string> = { "'": "'", '"': '"', '`': '`', '[': ']' };

/**
 * The first statement of `sql`: where it ends (past its `;`), the first word
 * it starts with, and whether it holds anything but space and comments.
 * Quoted strings, quoted names and comments are skipped, so a `;` inside
 * them ends nothing.
 */
function firstStatement(sql: string): { end: number; word: string; empty: boolean } {
	let word = '';
	let empty = true;
	let at = 0;
	while (at < sql.length) {
		const char = sql.charAt(at);
		const pair = sql.slice(at, at + 2);
		if (pair === '--') {
			const line = sql.indexOf('\n', at);
			at = line === -1 ? sql.length : line + 1;
			continue;
		}
		if (pair === '/*') {
			const close = sql.indexOf('*/', at + 2);
			at = close === -1 ? sql.length : close + 2;
			continue;
		}
		if (char === ';') return { end: at + 1, word, empty };
		if (/\s/.test(char)) {
			at++;
			continue;
		}
		empty = false;
		const closing = CLOSING[char];
		if (closing !== undefined) {
			at++;
			// A doubled quote inside quotes is one quote character.
			for (;;) {
				const close = sql.indexOf(closing, at);
				if (close === -1) return { end: sql.length, word, empty };
				at = close + 1;
				if (closing === ']' || sql.charAt(at) !== closing) break;
				at++;
			}
			continue;
		}
		const name = /^[A-Za-z_]\w*/.exec(sql.slice(at))?.[0];
		if (name === undefined) {
			at++;
			continue;
		}
		if (word === '') word = name.toUpperCase();
		at += name.length;
	}
	return { end: sql.length, word, empty };
}

/**
 * The statement kinds a read may be. A statement's kind is its first word.
 * `query_only` refuses every write these can hold (a `WITH` before an
 * `UPDATE`), but not a transaction, an ATTACH (which creates its file) or a
 * PRAGMA that changes the connection, so those are refused by kind.
 */
const READ_KINDS = new Set(['SELECT', 'WITH', 'VALUES']);

/** The one statement `sql` holds, if it is a read; `bun:sqlite` would run the first and skip the rest. */
function oneRead(sql: string): string {
	const { end, word } = firstStatement(sql);
	if (!READ_KINDS.has(word)) throw new Error(`A read is a SELECT, WITH or VALUES statement, not ${word === '' ? 'nothing' : word}`);
	for (let rest = sql.slice(end); rest !== ''; ) {
		const next = firstStatement(rest);
		if (!next.empty) throw new Error('A read is one statement');
		rest = rest.slice(next.end);
	}
	return sql.slice(0, end);
}

/** Open a database file, or an in-memory database by default. */
export function openBunSqlite(filename = ':memory:'): SqlDriver {
	const db = new Database(filename, { create: true, strict: true });
	if (filename !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
	return {
		exec(sql) {
			db.exec(sql);
		},
		all<TRow>(sql: string, params: SqlValue[] = []) {
			return db.query(sql).all(...params) as TRow[];
		},
		run(sql, params = []) {
			db.query(sql).run(...params);
		},
		read<TRow>(sql: string, params: SqlValue[] = []) {
			const statement = oneRead(sql);
			// The same connection, so the app's temporary views are there.
			db.exec('PRAGMA query_only = ON');
			try {
				return db.prepare(statement).all(...params) as TRow[];
			} finally {
				db.exec('PRAGMA query_only = OFF');
			}
		},
		transaction(fn) {
			return db.transaction(fn)();
		},
		close() {
			db.close();
		},
	};
}
