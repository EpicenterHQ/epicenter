/**
 * Y.Doc Array Key Conventions
 *
 * The document API stores data in Y.Arrays with these key patterns:
 * - Tables: `table:{tableName}` (one array per table)
 * - KV: `'kv'` (single array for all settings)
 *
 * These prefixes are reserved. Do not create Y.Doc arrays with keys
 * matching these patterns outside of the document API.
 *
 * Connection state does not live in the Y.Doc. No Y.Doc array is reserved for
 * transport bookkeeping.
 *
 * @example
 * ```typescript
 * import { KV_KEY, TableKey } from '@epicenter/workspace';
 *
 * const kvArray = ydoc.getArray(KV_KEY);                 // 'kv'
 * const postsArray = ydoc.getArray(TableKey('posts'));    // 'table:posts'
 * ```
 */

/** The KV settings array key. */
export const KV_KEY = 'kv';

/** Key type for the KV settings array. */
export type KvKey = typeof KV_KEY;

/** Key type for table arrays: `table:{tableName}`. */
export type TableKey<T extends string = string> = `table:${T}`;

/**
 * Create a table array key from a table name.
 *
 * The generic preserves the literal type when called with a string literal,
 * enabling precise type inference.
 */
export function TableKey<T extends string>(name: T): TableKey<T> {
	return `table:${name}`;
}
