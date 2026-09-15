/**
 * What an application declares, and what that declaration reads as.
 *
 * All vocabulary and no behaviour. A definition names value fields directly
 * on each table and reserves one content codec beside them; the lens at the
 * bottom turns that declaration into the types an application writes.
 *
 * Every type here is a LOOKUP. None asks whether its argument is a
 * declaration, because the parameter says so, and none can answer `never` for
 * "I could not tell". A definition that arrived as JSON never comes through
 * here: it reaches `compileData` from a trusted TypeScript module and is
 * checked in `compile.ts`.
 */

import type { BlobId } from '@epicenter/blobs';
import type * as Y from '@y/y';
import { type Static, type TSchema, Type } from 'typebox';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Result } from 'wellcrafted/result';
import {
	ATTACHMENT_KEYWORD,
	BLOB_KEYWORD,
	type Field,
	field as genericField,
} from '../field/index.js';

export const RESERVED_ATTRIBUTE_PREFIX = '!';
export const KV_ROOT = 'kv';
export const RESERVED_TABLE_NAMES: readonly string[] = [KV_ROOT];

/**
 * The fields of one bucket, by name.
 *
 * A field IS a schema. It was `object` for one release, so that this one type
 * could describe both a declaration written with `field.*` and one that arrived
 * as JSON, and every type reading a declaration paid for it: unable to assume a
 * schema, each asked `extends TSchema` and answered `never` when the guess
 * failed. A wrong answer, silently, rather than an error.
 *
 * Nothing needed it. A definition is imported from a first-party TypeScript
 * module, so the serialized shape never needs a static form to accommodate.
 * What is declared here is what an author writes.
 */
export type FieldMap = {
	readonly [field: string]: TSchema;
};

export const ContentError = defineErrors({
	/**
	 * A table's own `decode` refused this text.
	 *
	 * Returned rather than thrown, because a folder a person hands to an import
	 * is data rather than a programmer error, and the import that reads it
	 * reports which file it could not read.
	 */
	Unreadable: ({ reason, cause }: { reason: string; cause?: unknown }) => ({
		message: `This content could not be read into a row's node: ${reason}`,
		reason,
		cause,
	}),
});
export type ContentError = InferErrors<typeof ContentError>;

/**
 * How one table's content node becomes text, and back (ADR-0296, ADR-0329).
 *
 * A row is its values and ONE live node. The platform owns the file: it
 * writes the values as frontmatter by field name and joins this below the
 * fence, and it reverses both. The table owns what its node MEANS, which is
 * these three verbs and nothing else.
 *
 * There is no default. A node carries a sequence and attributes at once, so
 * "render it as text" is not a safe fallback: `toString` is a debug rendering,
 * not a serialization, and feeding its output back through `insert` turns an
 * attribute-bearing node into one literal string that PRINTS IDENTICALLY. A
 * table that declares no codec can export only an empty node.
 *
 * **`decode` mints and `rewrite` edits, and they are not the same verb.**
 * `decode` builds a node for a row that does not exist yet, and the node it
 * returns must be fresh: two rows given one node share it, silently, so
 * `createRow` refuses one that already belongs to a document. **How you fill
 * it matters**: one bulk operation or attribute writes are safe, a loop of
 * positional appends silently reverses, and it reads as empty until `create`
 * integrates it. `evidence/detached-type.test.ts` pins that.
 *
 * `rewrite` takes the node a row already holds and makes its content say what
 * the text says, in place. It is what a push calls when a person authorizes a
 * body edit to come home (ADR-0337), and it is not derivable from `decode`: a
 * detached node reads as empty until it is integrated, so there is nothing to
 * copy across, and only the codec knows whether its content lives in the
 * node's sequence, its attributes, or both.
 *
 * **In place, rather than as a replacement**, which is the whole reason this
 * is a verb here rather than a store one. Setting a fresh node over the row's
 * attribute is the lazy-mint case ADR-0296 rules out: two devices doing it
 * concurrently resolve by attribute LWW and one loses its whole subtree, and
 * every editor, undo manager, and preview bound to the old node is detached
 * with it. Editing the node the row already holds keeps every binding and is
 * one ordinary commit.
 *
 * **It is not lossless, and the difference is worth knowing exactly**
 * (`evidence/rewriting-a-body.test.ts`). The two codecs whose content is a
 * SEQUENCE clear it and refill it, so they keep the node and discard what was
 * in it: a peer's keystrokes INSIDE a block this removed are gone with the
 * block, because deleting a nested type reclaims what is under it. What
 * survives is a block the peer added beside the old ones, and two concurrent
 * rewrites concatenate rather than one winning. A codec whose content is in
 * ATTRIBUTES reconciles by key instead and pays none of that, which is another
 * way of saying only the codec knows what its node's content is. Either way
 * this is better than a replacement rather than safe: a replacement would have
 * lost one device's whole node and every binding to it.
 *
 * What `rewrite` does NOT promise is a minimal edit. A person asked for the
 * file's version to win, and that is what they get. A real text diff would
 * make the change smaller, the undo step finer, and a peer's concurrent
 * keystrokes survivable where the two edits do not overlap; it can replace a
 * codec's body later with no change here.
 */
export type ContentCodec = {
	readonly encode: (node: Y.Type) => string;
	readonly decode: (text: string) => Result<Y.Type, ContentError>;
	readonly rewrite: (node: Y.Type, text: string) => Result<void, ContentError>;
};

/**
 * The field every row holds its live node at, reserved the way `id` is.
 *
 * A row has exactly one, because one file has one region below the fence and
 * an export that could not write a second node would be losing data rather
 * than formatting it. Naming it per table would be a second name for a role
 * the structure already fixes.
 */
export const CONTENT_FIELD = 'content';

/**
 * One table's declaration, as the inert definition carries it.
 *
 * Every top-level key except `content` is a value field: it holds one JSON
 * value, replaced whole on write, last write wins, and written to the file's
 * frontmatter under its own field name. The content is the row's one live node:
 * edited in place, merging internally, and written below the fence through the
 * codec declared here.
 *
 * `content` is optional, with no default codec. Export refuses a populated
 * node without a codec; import refuses a nonempty body without one.
 */
export type TableDeclaration = {
	/** Value field descriptors live directly on the table. */
	readonly [key: string]: unknown;
	/** How this table's content node becomes text, and back. */
	readonly content?: ContentCodec;
};

/**
 * The mark `defineTable` leaves, and the only way to get one.
 *
 * A table declaration is a plain object, so any literal of the right shape used
 * to satisfy `DataDefinition`. That made two authoring paths for one thing:
 * `defineTable`, which checks its parameter, and a bare literal handed to
 * `defineData`, which needed a second set of conditional types to re-check the
 * same rules and could not report them as well. Every rule was written twice
 * and one of the copies silently stopped applying for a day.
 *
 * Nominal, so there is one door. Nothing constructs this value: the brand is
 * declared and never assigned, and `defineTable`'s return asserts it.
 */
declare const DECLARED: unique symbol;

/**
 * The mark alone, without the shape.
 *
 * `defineTable` returns this intersected with the literal types it inferred,
 * never with `TableDeclaration`, so the row lens sees the exact field keys.
 */
export type DeclaredMark = { readonly [DECLARED]: true };

/** A table declaration that went through `defineTable`. */
export type DeclaredTable = TableDeclaration & DeclaredMark;

/** One durable data domain's complete, inert definition. */
export type DataDefinition = {
	readonly id: string;
	readonly title?: string;
	readonly kv: FieldMap;
	readonly tables: {
		readonly [table: string]: DeclaredTable;
	};
};

/**
 * Add data-substrate nullability without teaching the generic field package
 * about it.
 *
 * `Type.Union` with `Type.Null`, which is TypeBox's own spelling of exactly
 * this. It emits the same `anyOf: [inner, { type: 'null' }]` the hand-rolled
 * version did, byte for byte, and infers `Static<S> | null` including for a
 * BRANDED inner schema, which is the case that made this a function in the
 * first place.
 *
 * It used to be built with `Type.Unsafe` and two casts, because a schema
 * assembled that way leaves its `Static` to be recovered structurally from the
 * `anyOf` and that recovery produced `unknown` for a branded `TUnsafe`:
 * `field.nullable(field.string())` read as `string | null` while
 * `field.nullable(field.instant())` read as `unknown`, in the same table. That
 * is a real defect in structural recovery and it is not a reason to reach for
 * the escape hatch, because `Type.Union` never had it.
 *
 * TypeBox retains the tuple for the owning-field input lens; runtime compilation
 * recognizes the same nullable shape from its serialized schema.
 */
function nullable<S extends TSchema>(inner: S) {
	return Type.Union([inner, Type.Null()]);
}

/** The data definition's field namespace. */
export const field = Object.freeze({
	...genericField,
	nullable,
});

export type DataField = {
	readonly name: string;
	readonly kind: Field['kind'];
	readonly schema: unknown;
	readonly check: (value: unknown) => boolean;
	readonly nullable: boolean;
	readonly reference: string | null;
};

/** What one bucket's fields read as, once the schemas are resolved. */
type FieldsOut<TFields extends FieldMap> = {
	[K in keyof TFields]: Static<TFields[K]>;
};

/**
 * One table's values: what `update` may patch, and what a row's
 * frontmatter carries. Every top-level schema except `content` is a value.
 *
 * The content node is absent because a node is not assignable: writing one
 * over a row's attribute deletes the old subtree, so a peer that edited it
 * concurrently loses every keystroke to map LWW. That rule is why this type
 * exists, and stating it as a signature is what keeps it from being a comment
 * somebody has to obey.
 */
type TableFields<T extends TableDeclaration> = {
	[K in keyof T as K extends string
		? K extends typeof CONTENT_FIELD
			? never
			: T[K] extends TSchema
				? K
				: never
		: never]: T[K] extends TSchema ? T[K] : never;
};

type TableValues<T extends TableDeclaration> = {
	[K in keyof TableFields<T>]: Static<TableFields<T>[K]>;
};

/**
 * One row: its id, its values, and its one live node.
 *
 * What `get` returns, what `create` returns, and what the export writes. No
 * conditional and no optionality: every row has a node, minted with it,
 * whether or not anything ever writes to it. Measured at 9 bytes per row for
 * an unwritten one against 31 for a written one, flat from a thousand rows to
 * a hundred thousand, which is what buys the simplicity here.
 */
export type RowOf<T extends TableDeclaration> = {
	id: string;
	content: Y.Type;
} & TableValues<T>;

/**
 * What `create` takes: values, attachment sources, and an optional content node.
 * Owning blob fields accept bytes or a local BlobId to copy, plus null when
 * declared nullable. Every attachment receives a new ID before row acceptance;
 * a source ID is never adopted or deleted by creation.
 *
 * The node is OPTIONAL, and that is what keeps a programmatic `create` from
 * having to build an empty one it does not care about: an omitted node is
 * minted empty. An import that decoded a file passes the node it built, and
 * `create` integrates it in the transaction that mints the row.
 *
 * A node handed here must not already belong to a document. Two rows given one
 * node SHARE it, silently, and the same node set into two documents corrupts
 * across them; `createRow` refuses an integrated node rather than letting
 * either happen.
 */
export type CreateRowOf<T extends TableDeclaration> = {
	[K in keyof TableFields<T>]: K extends AttachmentFieldNames<T>
		? null
		: K extends BlobFieldNames<T>
			? BlobId | Blob | Extract<Static<TableFields<T>[K]>, null>
			: Static<TableFields<T>[K]>;
} & {
	content?: Y.Type;
};

/** The declared fields whose bytes are owned by the table rather than stored inline. */
export type BlobFieldNames<T extends TableDeclaration> = {
	[K in keyof TableFields<T>]: TableFields<T>[K] extends
		| { [BLOB_KEYWORD]: true }
		| {
				anyOf:
					| [{ [BLOB_KEYWORD]: true }, { type: 'null' }]
					| [{ type: 'null' }, { [BLOB_KEYWORD]: true }];
		  }
		? K
		: never;
}[keyof TableFields<T>];

export type AttachmentFieldNames<T extends TableDeclaration> = {
	[K in keyof TableFields<T>]: TableFields<T>[K] extends {
		anyOf: [{ [ATTACHMENT_KEYWORD]: true }, { type: 'null' }];
	}
		? K
		: never;
}[keyof TableFields<T>];

export type KvOf<TDatabase extends DataDefinition> = FieldsOut<TDatabase['kv']>;
