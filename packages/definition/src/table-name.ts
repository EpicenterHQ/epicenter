/**
 * The grammar of a durable table name.
 *
 * A table name is mounted as a SQL relation by a trusted inspection host, so it
 * must be a bare identifier and `SELECT * FROM notes` must need no quoting
 * (ADR-0162). Renaming a table produces a different name and therefore a
 * different thing; there is no rename operation and no alias.
 */

/** A durable table name: one bare SQL identifier, so a mount needs no quoting. */
const TABLE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The longest table name, in bytes; the grammar admits ASCII only. */
const TABLE_NAME_BYTES = 64;

/**
 * The SQLite keywords that cannot be a bare relation name.
 *
 * A table name is mounted as a bare relation by the trusted inspection host, and
 * the promise is that `SELECT * FROM notes` needs no quoting. Some keywords
 * break that promise: `SELECT * FROM order` is a syntax error however carefully
 * the host generated the view. Refusing the name where it is declared is the
 * only point where the author can still fix it; refusing later would mean a
 * schema that parses cleanly and then cannot be inspected.
 *
 * This is not the full keyword list, and deliberately so. SQLite accepts most of
 * its own keywords as identifiers: `rows`, `key`, `view`, `first`, `range` and
 * eighty-odd others parse fine unquoted, and refusing them would cost real
 * names for no benefit. These are the ones measured to actually fail, so the
 * rule matches the promise exactly rather than approximating it.
 */
const SQLITE_UNUSABLE_AS_RELATION_NAME = new Set(
	`add all
	alter and as autoincrement between case check collate commit constraint create
	default deferrable delete distinct drop else escape except exists foreign from
	group having if in index insert intersect into is isnull join limit not
	nothing notnull null on or order primary references returning select set table
	then to transaction union unique update using values when where`.split(/\s+/),
);

/**
 * Whether a durable table name is usable as a bare SQL relation.
 *
 * Stricter than the character pattern alone, because the pattern is not the
 * whole promise. The promise is that a trusted host can mount this name and
 * write `SELECT * FROM <name>` with no quoting and no collision, so two more
 * things must hold: the name is not a SQLite keyword (case-insensitively), and
 * it does not enter SQLite's reserved `sqlite_` space.
 */
export function isTableName(value: string): boolean {
	if (value.length > TABLE_NAME_BYTES || !TABLE_NAME.test(value)) return false;
	const lowercased = value.toLowerCase();
	return (
		!SQLITE_UNUSABLE_AS_RELATION_NAME.has(lowercased) &&
		!lowercased.startsWith('sqlite_')
	);
}
