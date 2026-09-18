/**
 * The document as the store lays it out, reachable without the store.
 *
 * Evidence reads a raw `Y.Doc` on purpose: what it asserts is the STORAGE
 * layout, so going through a table handle would prove nothing about it. What
 * it does not need is to re-learn, at every line, how to say that layout to
 * the compiler.
 *
 * `Y.Type`'s default configuration types no attributes at all, so `keyof` its
 * attribute map is empty and the key parameter of `getAttr` and `setAttr`
 * narrows to `never`. Every raw access therefore had to lie twice: once about
 * the key, once about what came back. That is a property of the library's
 * generic default, not of anything Epicenter decided, and naming the
 * configuration once is all it takes to stop repeating the lie.
 *
 * `src/store/document.ts` already solved this for production with the same
 * two lines, for the same reason, and its `RowType` is deliberately not
 * exported: it is the CRDT shape a row happens to have, which that module
 * exists to keep inside. This is the evidence-side twin, and it stays here.
 */
import type * as Y from '@y/y';

import type { JsonValue } from '../../src/data/definition/json.js';

/**
 * A type whose attributes are values: a row, a kv root, any JSON-valued bag.
 *
 * The same declaration `document.ts` makes for a row, under the declaration's
 * own word for a JSON-valued attribute. A variable typed with this needs no
 * cast to read or write one, which is where nearly every cast in evidence came
 * from.
 */
export type ValuesType = Y.Type<{ attrs: Record<string, JsonValue> }>;

/**
 * Read a type as a bag of values.
 *
 * `Y.Doc.get` and the root helpers in `src/store/document.js` all hand back an
 * unconfigured type, so this is where a test states the shape of one it is
 * about to fill with JSON. A root holding ROWS is not this: see `rowAt`.
 */
export function asValues(type: Y.Type): ValuesType {
	return type as ValuesType;
}

/**
 * The row at this address, or `undefined`.
 *
 * The one cast, and the reason it cannot be typed away is the reason
 * `document.ts` states at its own copy: a `DeltaConf`'s attribute values must
 * be `Fingerprintable`, and a nested `Y.Type` is not one, so a TABLE ROOT,
 * whose attributes are themselves types, has no expressible configuration. A
 * ROW's does, which is why everything downstream of this line is typed.
 */
export function rowAt(root: Y.Type, rowId: string): ValuesType | undefined {
	return root.getAttr(rowId as never) as ValuesType | undefined;
}

/** Put a row at this address, minting nothing. */
export function putRow(root: Y.Type, rowId: string, row: Y.Type): void {
	root.setAttr(rowId as never, row as never);
}

/**
 * Hang a nested type on a row, under one attribute name.
 *
 * Separate from writing a value for the same reason `rowAt` needs a cast: the
 * attribute is a `Y.Type`, which no attribute configuration can describe.
 * Keeping it its own verb means a value write stays honest.
 */
export function putType(row: Y.Type, name: string, type: Y.Type): void {
	row.setAttr(name as never, type as never);
}

/** The nested type at this attribute name, or `undefined`. */
export function typeAt(row: Y.Type, name: string): Y.Type | undefined {
	return row.getAttr(name as never) as Y.Type | undefined;
}
