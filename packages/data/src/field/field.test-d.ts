/**
 * Compile-time type tests for the `field.*` builders. Compiled by `tsc --noEmit`
 * alongside the rest of the package; nothing runs at test time.
 *
 * Pattern: each assertion is exported so `noUnusedLocals` does not flag it. If an
 * assertion fails, the type error appears at the offending line during typecheck.
 *
 * The bet these prove: branding rides on `Type.Unsafe`, so the at-rest wire-form
 * (what `recognize` reads) and the authored `Static<>` are decoupled. The
 * load-bearing one is `_SelectStatic` (OQ2): native `enum` must still carry the
 * literal union, not widen to `string`.
 */

import type { Static, Type } from 'typebox';
import type { BlobId } from '@epicenter/blobs';
import type { Brand } from 'wellcrafted/brand';
import type { JsonValue } from 'wellcrafted/json';
import type { field, jsonValue } from './builders.js';
import type { CalendarDateString } from './calendar-date-string.js';
import type { DateTimeString } from './datetime-string.js';
import type { InstantString } from './instant-string.js';

/**
 * A failed assertion carries both sides, so the error names what moved.
 *
 * `Expect` requires `true`, so an unequal pair reports the object below rather
 * than `Type 'false' does not satisfy the constraint 'true'`, which names
 * neither type:
 *
 *     Type '{ expected: "draft" | "published"; got: string; }'
 *     does not satisfy the constraint 'true'.
 *
 * Copied rather than shared. It is four lines of the canonical spelling with no
 * semantics of its own, and the three copies live in `packages/data/src/field`,
 * `packages/data/src/definition`, and `apps/whispering`, which do not
 * otherwise reach into each other for test
 * utilities. `wellcrafted/testing` exports this pair as of the release after
 * 0.44.0; import it from there once the catalog moves and these go.
 */
type Equal<X, Y> =
	(<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2
		? true
		: { expected: Y; got: X };
type Expect<T extends true> = T;

type NoteId = string & Brand<'NoteId'>;

// field.blob(): Static = the opaque BlobId carried by a persisted row
export type _BlobStatic = Expect<
	Equal<Static<ReturnType<typeof field.blob>>, BlobId>
>;

// field.string(): Static = string
export type _StringStatic = Expect<
	Equal<Static<ReturnType<typeof field.string>>, string>
>;

// field.string<NoteId>(): Static = NoteId (brand preserved)
export type _StringBrandStatic = Expect<
	Equal<Static<ReturnType<typeof field.string<NoteId>>>, NoteId>
>;

// field.string<'draft'>(): never (literal subtypes rejected; use field.select)
export type _StringLiteralRejected = Expect<
	Equal<ReturnType<typeof field.string<'draft'>>, never>
>;

// field.reference('table'): Static = string (unbranded, but always TUnsafe for the marker)
export type _ReferenceStatic = Expect<
	Equal<Static<ReturnType<typeof field.reference>>, string>
>;

// field.reference<NoteId>('table'): Static = NoteId (brand preserved)
export type _ReferenceBrandStatic = Expect<
	Equal<Static<ReturnType<typeof field.reference<NoteId>>>, NoteId>
>;

// field.reference<'draft'>('table'): never (literal subtypes rejected, like field.string)
export type _ReferenceLiteralRejected = Expect<
	Equal<ReturnType<typeof field.reference<'draft'>>, never>
>;

// field.url(): Static = string
export type _UrlStatic = Expect<
	Equal<Static<ReturnType<typeof field.url>>, string>
>;

// field.date(): Static = CalendarDateString (brand preserved)
export type _DateStatic = Expect<
	Equal<Static<ReturnType<typeof field.date>>, CalendarDateString>
>;

// field.instant(): Static = InstantString (brand preserved)
export type _InstantStatic = Expect<
	Equal<Static<ReturnType<typeof field.instant>>, InstantString>
>;

// field.datetime(): Static = DateTimeString (brand preserved)
export type _DatetimeStatic = Expect<
	Equal<Static<ReturnType<typeof field.datetime>>, DateTimeString>
>;

// field.select([...]): Static = literal union of members  (OQ2)
const statusIds = ['draft', 'published'] as Array<'draft' | 'published'>;
export type _SelectStatic = Expect<
	Equal<
		Static<ReturnType<typeof field.select<typeof statusIds>>>,
		'draft' | 'published'
	>
>;

// field.select is string-only: a numeric member list is a compile error.
// @ts-expect-error select holds strings; a numeric range is integer + min/max
field.select([1, 2, 3]);

// field.multiSelect([...]): Static = array of the literal union
export type _MultiSelectStatic = Expect<
	Equal<
		Static<ReturnType<typeof field.multiSelect<typeof statusIds>>>,
		('draft' | 'published')[]
	>
>;

// field.tags(): Static = string[]
export type _TagsStatic = Expect<
	Equal<Static<ReturnType<typeof field.tags>>, string[]>
>;

// field.number / field.integer: Static = number; field.boolean: Static = boolean
export type _NumberStatic = Expect<
	Equal<Static<ReturnType<typeof field.number>>, number>
>;
export type _IntegerStatic = Expect<
	Equal<Static<ReturnType<typeof field.integer>>, number>
>;
export type _BooleanStatic = Expect<
	Equal<Static<ReturnType<typeof field.boolean>>, boolean>
>;

// field.json(inner): Static = Static<inner>. The authoring type tracks the payload schema;
// the at-rest wire-form carries the x-json-schema marker, decoupled from Static<> via Unsafe.
export type _JsonTypedStatic = Expect<
	Equal<
		Static<
			ReturnType<
				typeof field.json<
					ReturnType<
						typeof Type.Object<{ author: ReturnType<typeof Type.String> }>
					>
				>
			>
		>,
		{ author: string }
	>
>;

// jsonValue: the canonical any-JSON inner, Static = JsonValue (pinned via Type.Unsafe).
export type _JsonValueStatic = Expect<
	Equal<Static<typeof jsonValue>, JsonValue>
>;

// field.json(Type.Array(jsonValue)): Static = JsonValue[]. The list-of-arbitrary-JSON
// pattern the apps share; the inner static flows through Array and field.json unchanged.
export type _JsonArrayStatic = Expect<
	Equal<
		Static<
			ReturnType<
				typeof field.json<ReturnType<typeof Type.Array<typeof jsonValue>>>
			>
		>,
		JsonValue[]
	>
>;
