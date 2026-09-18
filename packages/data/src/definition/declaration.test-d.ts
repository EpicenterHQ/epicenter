import { type BlobId, generateBlobId } from '@epicenter/blobs';
import type * as Y from '@y/y';
import { type Static, Type } from 'typebox';
import type {
	CalendarDateString,
	DateTimeString,
	InstantString,
} from '../field/index.js';
import type { TypedTableHandle } from '../store/handles.js';
import { plainText } from './content.js';
import {
	type CreateRowOf,
	defineData,
	defineTable,
	field,
	type RowOf,
} from './index.js';

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

const definition = defineData({
	id: 'so.epicenter.definition-types',
	kv: {
		status: field.select(['draft', 'published']),
		labels: field.multiSelect(['a', 'b']),
		date: field.date(),
		instant: field.instant(),
		datetime: field.datetime(),
		payload: field.json(field.select(['small', 'large'])),
		optional: field.nullable(field.string()),
	},
	tables: {
		items: defineTable({
			status: field.select(['draft', 'published']),
			content: plainText(),
		}),
		recordings: defineTable({
			audio: field.string<BlobId>(),
			optional: field.nullable(field.string<BlobId>()),
			ordinaryId: field.string<BlobId>(),
			content: plainText(),
		}),
		reversed: defineTable({
			audio: Type.Union([Type.Null(), field.string<BlobId>()]),
			content: plainText(),
		}),
	},
});

type Item = RowOf<typeof definition.tables.items>;
type Values = typeof definition.kv;
type Recording = RowOf<typeof definition.tables.recordings>;
type RecordingInput = CreateRowOf<typeof definition.tables.recordings>;

export type _NullableIdentifierInput = Expect<
	Equal<RecordingInput['optional'], BlobId | null>
>;
export type _BrandedStringIsNotOwning = Expect<
	Equal<RecordingInput['ordinaryId'], BlobId>
>;
export type _ReversedNullableInput = Expect<
	Equal<CreateRowOf<typeof definition.tables.reversed>['audio'], BlobId | null>
>;
export type _ReversedNullableRead = Expect<
	Equal<RowOf<typeof definition.tables.reversed>['audio'], BlobId | null>
>;
export type _ReversedNullableCreateIsSynchronous = Expect<
	ReturnType<
		TypedTableHandle<typeof definition.tables.reversed>['create']
	> extends RowOf<typeof definition.tables.reversed>
		? true
		: false
>;

export type _SelectStatic = Expect<
	Equal<Static<Values['status']>, 'draft' | 'published'>
>;
export type _MultiSelectStatic = Expect<
	Equal<Static<Values['labels']>, ('a' | 'b')[]>
>;
export type _DateStatic = Expect<
	Equal<Static<Values['date']>, CalendarDateString>
>;
export type _InstantStatic = Expect<
	Equal<Static<Values['instant']>, InstantString>
>;
export type _DatetimeStatic = Expect<
	Equal<Static<Values['datetime']>, DateTimeString>
>;
export type _JsonStatic = Expect<
	Equal<Static<Values['payload']>, 'small' | 'large'>
>;
export type _NullableStatic = Expect<
	Equal<Static<Values['optional']>, string | null>
>;
export type _RowStatusStatic = Expect<
	Equal<Item['status'], 'draft' | 'published'>
>;
export type _RowIdIsString = Expect<Equal<Item['id'], string>>;
export type _RowContentIsLiveType = Expect<Equal<Item['content'], Y.Type>>;
export type _BlobRowStoresId = Expect<Equal<Recording['audio'], BlobId>>;

declare const content: Y.Type;
const createWithoutContent: CreateRowOf<typeof definition.tables.items> = {
	status: 'draft',
};
const createWithContent: CreateRowOf<typeof definition.tables.items> = {
	status: 'published',
	content,
};
void createWithoutContent;
void createWithContent;
const createRecording: RecordingInput = {
	audio: generateBlobId('wav'),
	optional: null,
	ordinaryId: generateBlobId('wav'),
};
void createRecording;
const copyRecording: RecordingInput = {
	audio: generateBlobId('wav'),
	optional: generateBlobId('wav'),
	ordinaryId: generateBlobId('wav'),
};
void copyRecording;
// @ts-expect-error: arbitrary strings are not validated blob keys.
const invalidCopy: RecordingInput['audio'] = 'not-a-blob-id';
void invalidCopy;

declare const recordings: TypedTableHandle<typeof definition.tables.recordings>;
recordings.create({
	// @ts-expect-error: row values cannot accept unpersisted bytes.
	audio: new Blob(['audio']),
	optional: null,
	ordinaryId: generateBlobId('wav'),
});
recordings.update('a'.repeat(24), { audio: generateBlobId('wav') });
export type _CreateIsSynchronous = Expect<
	Equal<ReturnType<typeof recordings.create>, Recording>
>;
