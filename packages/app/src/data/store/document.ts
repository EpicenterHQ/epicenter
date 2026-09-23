import { type JsonObject, type JsonValue } from '@epicenter/app/definition';

import * as Y from '@y/y';
/**
 * A database's document: one per database, holding every table's rows and
 * every row's body node (ADR-0295).
 *
 * There is no second document and no address that reaches one. A row is a
 * nested type on its table root, and the body node is the row's sole sequence child,
 * so what used to be N documents multiplexed over one connection is one
 * document with one identity, one socket, one stored blob.
 */
export function createDatabaseDocument(): Y.Doc {
	// `gc: true` is what collapses a field edited 5,000 times to two structs.
	// The CRDT keeps no history to lose by it: what a person keeps is the
	// export (ADR-0268), and collapse supersedes rather than discards
	// (ADR-0269).
	return new Y.Doc({ gc: true });
}

/**
 * The root holding one table's rows, minting it if this document has never
 * seen it.
 *
 * Minting is safe here and nowhere else. `Doc.get` is
 * `map.setIfUndefined(this.share, key, ...)`, so it creates on miss, and a root
 * can never be removed: reaching into `doc.share` and deleting one corrupts the
 * encoder outright. Every key that reaches this function is a table name the
 * database declares, so the set of roots is bounded by the declaration rather
 * than by user input. A row id must never be passed here; rows are attributes on this root,
 * which is what keeps `doc.share` at table count rather than row count.
 *
 * That bound is the whole reason for the nested grammar. `Item.write` calls
 * `findRootTypeKey`, a linear scan of `doc.share`, so one root per row makes
 * encoding quadratic in rows: 5,417 ms at 20,000 rows against 13 ms nested.
 */
export function tableRoot(document: Y.Doc, tableName: string): Y.Node {
	return document.get(tableRootName(tableName));
}

/**
 * A table's root is tagged with its kind; the one non-table root is not.
 *
 * `tables:<name>` for a table and a bare `kv` for the settings root, so a
 * `doc.share` dump reads as a description of the application rather than as a
 * list of nouns whose kind you have to infer. The tag is a KIND, not a path,
 * which is why it is a colon: rows are attributes on the root rather than
 * further segments, so `tables/notes` would invite an address that does not
 * exist.
 *
 * The tag is legibility rather than safety, and it is worth being clear about
 * that. `compileData` already refuses `kv` as a table name outright, because it
 * would collide with the `db.kv` handle key, so a table can no more reach the
 * settings root than it can be declared. `tables:kv` is a second guard on a
 * collision the first one already made unreachable.
 */
export function tableRootName(tableName: string): string {
	return `tables:${tableName}`;
}

const TABLE_ROOT_PREFIX = 'tables:';

/**
 * Every table this document actually holds a root for, declared or not.
 *
 * The one place a root name is read back into a table name, kept here beside
 * the composition so the tag stays this module's business and no caller learns
 * to slice the prefix itself. It reads `share` rather than a declaration on
 * purpose: a table an older release wrote and this one no longer names still
 * has its rows in the CRDT (ADR-0240), and a faithful read of what is stored
 * is exactly the caller that must not miss it.
 */
export function storedTableNames(document: Y.Doc): string[] {
	const names: string[] = [];
	for (const rootName of document.share.keys()) {
		if (!rootName.startsWith(TABLE_ROOT_PREFIX)) continue;
		names.push(rootName.slice(TABLE_ROOT_PREFIX.length));
	}
	return names.sort();
}

/** The root every application's settings live at (ADR-0216). */
export const KV_ROOT_NAME = 'kv';

/**
 * The KV root, minting it on miss.
 *
 * Separate from `tableRoot` because it is not a table and must not be prefixed
 * as one. Minting is safe for the same reason a table's is: `Doc.get` is
 * `setIfUndefined`, so every device that mints `kv` converges on one root.
 */
export function kvRoot(document: Y.Doc): Y.Node {
	return document.get(KV_ROOT_NAME);
}

/**
 * One row's nested type, or undefined when the table holds no row there.
 *
 * This is the whole of existence. A row IS a nested type on the table root, so
 * holding one is what it means to exist and removing it is what deletion does.
 * There is no second fact to consult and therefore nothing that can disagree
 * with this one.
 *
 * Unlike `Doc.get`, `getAttr` does not mint: verified against
 * `@y/y@14.0.0-rc.26`, reading an unknown row id leaves the table root's
 * attribute keys unchanged. So a misspelled row id costs nothing here, while a
 * misspelled table name would cost a permanent root.
 */
function rowType(root: Y.Node, rowId: string): RowType | undefined {
	// A table root stays at the Yjs default configuration, so its keys are
	// `string` and this is a plain read. It cannot be configured further: a
	// `DeltaConf`'s `attrs` values must be `Fingerprintable` and a nested
	// `Y.Node` is not one, so a container whose attributes are themselves types
	// has no expressible shape. A ROW's does, which is why `RowType` exists and
	// why the value is narrowed here rather than asserted.
	const value: unknown = root.getAttr(rowId);
	return value instanceof Y.Node ? (value as RowType) : undefined;
}

/**
 * One row's own type: JSON attributes and one stable body child.
 *
 * Declared so that reading and writing a field is typed rather than cast. The
 * `as never` this replaces was not defensive, it was the default `DConf = any`
 * collapsing `keyof` to nothing, so every field access had to lie to the
 * compiler to say anything at all.
 *
 * Not exported. It was, for one commit, and nothing outside this file wanted
 * it: a caller reaches a row through `readRow` and `createRow`, which speak
 * `JsonObject`. Exporting it would publish the CRDT shape a row happens to
 * have, which is the thing this module exists to keep in here.
 */
type RowType = Y.Node<{ attrs: Record<string, JsonValue> }>;

/** Whether this table holds a row at this address. */
export function hasRow(root: Y.Node, rowId: string): boolean {
	return rowType(root, rowId) !== undefined;
}

/**
 * Stored value fields, including undeclared and !-prefixed names.
 * Nested nodes stay out of value snapshots; the declaration owns conformance.
 */
export function readRow(root: Y.Node, rowId: string): JsonObject | undefined {
	const row = rowType(root, rowId);
	if (row === undefined) return undefined;
	const payload: JsonObject = {};
	for (const name of row.attrKeys()) {
		const value = row.getAttr(name);
		if (value === undefined) continue;
		// Read every stored value, including undeclared fields. A malformed
		// node-valued attribute must not leak into a JSON snapshot.
		if (value instanceof Y.Node) continue;
		payload[name] = value as JsonValue;
	}
	return payload;
}

/**
 * One row's body node.
 *
 * The row container owns exactly one sequence child. Reject a malformed
 * container without repairing it on read. Creation integrates the child once,
 * in the row's transaction; field writes never modify the row's sequence.
 */
export function readRowBody(root: Y.Node, rowId: string): Y.Node | undefined {
	const row = rowType(root, rowId);
	if (row === undefined) return undefined;
	if (row.length !== 1) return undefined;
	const value: unknown = row.get(0);
	return value instanceof Y.Node ? value : undefined;
}

/**
 * Every row id in this table, sorted.
 *
 * Pays only for the rows that are there. An earlier design kept a deleted row's
 * container attached to the root and flagged it absent, which made this a scan
 * over every row the table had ever held: measured, listing a thousand rows
 * among a hundred thousand corpses took 24.9 ms. Deletion removes the
 * attribute, so `attrKeys` yields the survivors and the dead are not walked.
 *
 * Still one `getAttr` per key rather than the raw key list, so that this agrees
 * with `readRow` on what a row is. A key holding something other than a nested
 * type is not a row anywhere else in this module, and an id this returns that
 * `get` then reports as absent would be worse than the lookup it saves.
 */
export function listRowIds(root: Y.Node): string[] {
	const ids: string[] = [];
	for (const key of root.attrKeys()) {
		const rowId = key as string;
		if (hasRow(root, rowId)) ids.push(rowId);
	}
	return ids.sort();
}

/**
 * Write fields into one row, minting the row if the table holds none there.
 *
 * Caller-supplied fields only: an absent key is left alone rather than being
 * filled from a declaration default. Missing values remain missing until the
 * application composes recovery. Must run inside a `transact`, so a minted row and
 * the fields it admits commit together.
 *
 * There is no revive path and no address to revive. Deletion takes the row's
 * attribute off the root, so a deleted address is indistinguishable from one
 * never used; `create` mints an id nothing has ever held, and `update` refuses
 * an address holding no row.
 */
export function createRow(
	root: Y.Node,
	rowId: string,
	fields: JsonObject,
	given?: Y.Node,
): void {
	validateRowFields(fields);
	if (given !== undefined && !(given instanceof Y.Node))
		throw new TypeError('The body must be a live Yjs node');
	const existing = rowType(root, rowId);
	if (existing === undefined && given !== undefined && given.doc !== null) {
		throw new Error(
			`the body given for row '${rowId}' already belongs to a document; build a fresh node per row`,
		);
	}
	const row = existing ?? mintRow(root, rowId);
	if (existing === undefined) {
		// **Integrated exactly once, in the transaction that mints the row.**
		// Root types converge by name; nested ones do not, so two devices
		// independently minting a node at the same key lose one subtree. Doing
		// it with the row removes the concurrency entirely, because a row id is
		// minted rather than chosen and no two devices ever mint the same one.
		//
		// **A given node must not already belong to a document.** Measured on
		// `@y/y@14.0.0-rc.26`: setting one node at two keys leaves both keys
		// holding the SAME node, so two rows would share it and edits to either
		// would appear in both, silently. `doc` is non-null exactly when a node
		// has been integrated, so refusing here makes that unrepresentable.
		// RC26 accepts nested Y.Node children at runtime, but DeltaConf restricts
		// children to Fingerprintable values. Keep that type-system gap here.
		row.insert(0, [(given ?? new Y.Node()) as never]);
	} else {
		if (given !== undefined) {
			throw new Error(
				`cannot replace the body node for existing row '${rowId}'; edit the live node instead`,
			);
		}
		if (readRowBody(root, rowId) === undefined) {
			throw new Error(
				`existing row '${rowId}' has no live body node; repair it before writing value fields`,
			);
		}
	}
	fill(row, fields);
}

/**
 * Write fields onto a row that already exists. Returns whether one did.
 *
 * The counterpart to `createRow`, and the whole reason they are two functions:
 * this one CANNOT bring a row into existence. Minting on a missing row is
 * correct for a create and wrong for everything else, and the case that proves
 * it is a derive. `deriveOnCommit` writes `updatedAt` onto a row whenever its
 * document commits, so a device editing the body of a note deleted elsewhere
 * would mint a NEW nested type at the same key — and a new type is new data,
 * not a revival, so nothing in Yjs can refuse it
 * (`evidence/invariants.test.ts`, "re-minting the type after the deletion
 * arrived DOES bring the row back").
 *
 * That resurrection is what `DocumentError.DocumentRetired` and the durable
 * `_tombstones` relation exist to keep unreachable. Splitting the mint out
 * makes it unreachable by construction instead, which is cheaper than
 * remembering every address that ever died.
 */
export function updateRow(
	root: Y.Node,
	rowId: string,
	fields: JsonObject,
): boolean {
	validateRowFields(fields);
	const row = rowType(root, rowId);
	if (row === undefined) return false;
	fill(row, fields);
	return true;
}

/**
 * The one place a row comes into existence.
 *
 * A nested type at a chosen key is addressed by its struct id, so two devices
 * minting one at the same key converge by last-writer-wins and one device's
 * subtree is lost (`evidence/invariants.test.ts`). What makes that unreachable
 * is not this function: it is that row ids are MINTED rather than chosen
 * (ADR-0216), so two devices never independently mint the same key. Written
 * down here because this is the line that would be unsafe if that ever stopped
 * being true.
 */
function mintRow(root: Y.Node, rowId: string): RowType {
	const row = new Y.Node() as RowType;
	root.setAttr(rowId, row);
	return row;
}

function fill(row: RowType, fields: JsonObject): void {
	for (const [name, value] of Object.entries(fields)) {
		row.setAttr(name, value as JsonValue);
	}
}

function validateRowFields(fields: JsonObject): void {
	for (const [name, value] of Object.entries(fields)) {
		if (name === 'id') {
			throw new TypeError(`Field '${name}' is reserved for row identity`);
		}
		if (value instanceof Y.Node)
			throw new TypeError(`Field '${name}' must be a JSON value`);
	}
}

/**
 * Take one row off its table. Returns whether there was a row to take.
 *
 * The whole subtree goes with the attribute: every value field AND every type
 * field's nested type. Deleting a nested type reclaims what is under it
 * (`evidence/invariants.test.ts`), so what remains is one deleted map key,
 * measured at 2.0 items and 44.5 bytes (`evidence/bench/tombstones.ts`).
 *
 * There is nothing else to retire. A row's body node is IN here now
 * (ADR-0295), so deletion is one removal in one document rather than a value
 * removal composed with a durable tombstone on a second address.
 *
 * ADR-0212 chose the other model: clear every field and set a reserved
 * `!presence` attribute to `absent`, leaving the container attached to the root
 * forever. It defended the extra cost by claiming that removing the attribute
 * destroys a concurrent edit while clearing converges with the peer's edit
 * retained. `evidence/deletion-model.test.ts` measured that claim and it does
 * not survive: under both models a concurrent delete and edit read identically,
 * both devices converge, and the delete wins whichever side goes first. The
 * retained edit is reachable through no verb here, and it comes back if the
 * address is ever revived, so retention was the worse half rather than the
 * benefit. What it cost was about 8 items and 116 bytes per dead row against
 * 2.0 and 44.5: over twenty recordings a day for a decade, 582,000 items and
 * 451 MB of resident memory against 156,000 and 101 MB, on every device that
 * ever opens the application.
 */
export function deleteRow(root: Y.Node, rowId: string): boolean {
	if (rowType(root, rowId) === undefined) return false;
	root.deleteAttr(rowId);
	return true;
}
