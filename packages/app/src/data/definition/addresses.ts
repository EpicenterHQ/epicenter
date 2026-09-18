/**
 * The durable names a database declares, and what makes each one admissible.
 *
 * A data id, a table name and a row id: three grammars and their byte
 * ceilings. There is no address TYPE here any more. A row used to own an
 * independent Yjs document at a derived `{dataId}/{tableName}/{rowId}` string,
 * and the structured `RowAddress` existed to compose it (ADR-0160, ADR-0164,
 * ADR-0206, ADR-0248); a database is one document now (ADR-0295), a row is an
 * attribute key on its table root, and nothing addresses one from outside.
 *
 * What survives is the grammar, because the names are still durable. A row id
 * still admits only characters safe verbatim in a URL path segment and still
 * refuses a leading `.`, `-` or `_`, because a row still becomes a file in an
 * exported folder (ADR-0268). A table name is still mounted as a SQL relation
 * by a trusted inspection host, so it must be a bare identifier and
 * `SELECT * FROM notes` must need no quoting (ADR-0162). Renaming any of them
 * produces a different name and therefore a different thing; there is no rename
 * operation and no alias.
 */

/** Reverse-domain data id: two or more lowercase, dot-separated labels. */
const DATA_ID_PATTERN =
	'^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$';
/** A durable table name: one bare SQL identifier, so a mount needs no quoting. */
const TABLE_NAME_PATTERN = '^[A-Za-z][A-Za-z0-9_]*$';
/**
 * A row id, whether the runtime minted it or an application chose it.
 *
 * Every admitted character is safe verbatim in a URL path segment, because a
 * row's bytes are read through a path built from its address (ADR-0173). The
 * leading character excludes `.`, `-`, and `_`, so no id can be a relative path
 * segment or hide as a dotfile in a store that uses one on disk.
 *
 * The comparison is case-sensitive, matching SQLite's default collation, so
 * `App` and `app` are two ordinary addresses rather than a collision. That is
 * the same treatment durable names get elsewhere: an id is data, not an
 * identifier a SQL parser has to resolve.
 */
const ROW_ID_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._-]*$';

const DATA_ID = new RegExp(DATA_ID_PATTERN);
const TABLE_NAME = new RegExp(TABLE_NAME_PATTERN);
const ROW_ID = new RegExp(ROW_ID_PATTERN);

/**
 * The SQLite keywords that cannot be a bare relation name.
 *
 * A table name is mounted as a bare relation by the trusted inspection host, and
 * the promise is that `SELECT * FROM notes` needs no quoting. Some keywords
 * break that promise: `SELECT * FROM order` is a syntax error however carefully
 * the host generated the view. Refusing the name where it is declared is the
 * only point where the author can still fix it; refusing later would mean a
 * database that parses cleanly and then cannot be inspected.
 *
 * This is not the full keyword list, and deliberately so. SQLite accepts most of
 * its own keywords as identifiers: `rows`, `key`, `view`, `first`, `range` and
 * eighty-odd others parse fine unquoted, and refusing them would cost real
 * names for no benefit. These are the ones measured to actually fail, so the
 * rule matches the promise exactly rather than approximating it.
 *
 * The set is a property of SQLite's parser, so `addresses.test.ts` re-derives it
 * against the linked SQLite and fails if the two ever disagree. A version that
 * changes the set is then a loud test failure rather than a database that silently
 * stops being inspectable.
 */
export const SQLITE_UNUSABLE_AS_RELATION_NAME: readonly string[] = `add all
	alter and as autoincrement between case check collate commit constraint create
	default deferrable delete distinct drop else escape except exists foreign from
	group having if in index insert intersect into is isnull join limit not
	nothing notnull null on or order primary references returning select set table
	then to transaction union unique update using values when where`.split(/\s+/);

const SQLITE_KEYWORDS = new Set(SQLITE_UNUSABLE_AS_RELATION_NAME);

/**
 * Byte ceilings for the durable coordinates of an address.
 *
 * Kept as plain numbers rather than a limits object so both the live exchange
 * protocol and the private V1 kernel can bound the same address grammar with
 * their own capacity models.
 */
export type AddressByteCeilings = {
	dataIdBytes: number;
	tableNameBytes: number;
	rowIdBytes: number;
};

/** The address-coordinate ceilings admitted by the public data vocabulary. */
export const DATA_ADDRESS_CEILINGS: AddressByteCeilings = {
	dataIdBytes: 128,
	tableNameBytes: 64,
	rowIdBytes: 128,
};

function utf8ByteLength(value: string): number {
	let bytes = 0;
	for (let index = 0; index < value.length; index += 1) {
		const codeUnit = value.charCodeAt(index);
		if (codeUnit < 0x80) {
			bytes += 1;
		} else if (codeUnit < 0x800) {
			bytes += 2;
		} else if (
			codeUnit >= 0xd800 &&
			codeUnit <= 0xdbff &&
			index + 1 < value.length
		) {
			const next = value.charCodeAt(index + 1);
			if (next >= 0xdc00 && next <= 0xdfff) {
				bytes += 4;
				index += 1;
			} else {
				bytes += 3;
			}
		} else {
			bytes += 3;
		}
	}
	return bytes;
}

/** Whether a durable data id is well formed and within its ceiling. */
export function isDataId(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	return bytes >= 3 && bytes <= ceilings.dataIdBytes && DATA_ID.test(value);
}

/**
 * Whether a durable table name is usable as a bare SQL relation.
 *
 * Stricter than the character pattern alone, because the pattern is not the
 * whole promise. The promise is that a trusted host can mount this name and
 * write `SELECT * FROM <name>` with no quoting and no collision, so two more
 * things must hold: the name is not a SQLite keyword (case-insensitively), and
 * it does not enter SQLite's reserved `sqlite_` space. Every relation Epicenter
 * storage occupies sits behind an underscore prefix, which the leading-letter
 * rule already makes unreachable.
 *
 * The same rule governs a database declaration and an address arriving on the
 * wire. One grammar, checked in one place: a name a database may not declare is
 * a name no peer may introduce either.
 */
export function isTableName(
	value: string,
	ceilings: AddressByteCeilings,
): boolean {
	const bytes = utf8ByteLength(value);
	if (bytes < 1 || bytes > ceilings.tableNameBytes) return false;
	if (!TABLE_NAME.test(value)) return false;
	const lowercased = value.toLowerCase();
	return !SQLITE_KEYWORDS.has(lowercased) && !lowercased.startsWith('sqlite_');
}

/**
 * Whether a row id is well formed and within its ceiling.
 *
 * One grammar for both origins. A minted id and a chosen one are the same kind
 * of name, so nothing downstream may branch on which it was (ADR-0206).
 */
export function isRowId(value: string, ceilings: AddressByteCeilings): boolean {
	const bytes = utf8ByteLength(value);
	return bytes >= 1 && bytes <= ceilings.rowIdBytes && ROW_ID.test(value);
}
