import { type BlobId, generateBlobId } from '@epicenter/blobs';
import type * as Y from '@y/y';
import { type Static, Type } from 'typebox';
import type { Result } from 'wellcrafted/result';
import type {
	CalendarDateString,
	DateTimeString,
	InstantString,
} from '../field/index.js';
import type { AttachmentError } from '../store/attachment.js';
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
			audio: field.blob(),
			optional: field.nullable(field.blob()),
			ordinaryId: field.string<BlobId>(),
			content: plainText(),
		}),
		reversed: defineTable({
			audio: Type.Union([Type.Null(), field.blob()]),
			content: plainText(),
		}),
	},
});

type Item = RowOf<typeof definition.tables.items>;
type Values = typeof definition.kv;
type Recording = RowOf<typeof definition.tables.recordings>;
type RecordingInput = CreateRowOf<typeof definition.tables.recordings>;

export type _NullableBlobInput = Expect<
	Equal<RecordingInput['optional'], Blob | BlobId | null>
>;
export type _BrandedStringIsNotOwning = Expect<
	Equal<RecordingInput['ordinaryId'], BlobId>
>;
export type _ReversedNullableInput = Expect<
	Equal<
		CreateRowOf<typeof definition.tables.reversed>['audio'],
		Blob | BlobId | null
	>
>;
export type _ReversedNullableRead = Expect<
	Equal<RowOf<typeof definition.tables.reversed>['audio'], BlobId | null>
>;
export type _ReversedNullableCreateIsAsync = Expect<
	ReturnType<
		TypedTableHandle<typeof definition.tables.reversed>['create']
	> extends Promise<unknown>
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
	audio: new Blob(['audio'], { type: 'audio/wav' }),
	optional: null,
	ordinaryId: generateBlobId(),
};
void createRecording;
const copyRecording: RecordingInput = {
	audio: generateBlobId(),
	optional: generateBlobId(),
	ordinaryId: generateBlobId(),
};
void copyRecording;
// @ts-expect-error: arbitrary strings are not validated copy-source IDs.
const invalidCopy: RecordingInput['audio'] = 'not-a-blob-id';
void invalidCopy;

const attachmentFields = defineTable({
	title: field.string(),
	audio: field.attachment(),
});
declare const attachmentTable: TypedTableHandle<typeof attachmentFields>;
// @ts-expect-error: an unfinished capture cannot create an attachment row.
attachmentTable.create({ title: 'capture', audio: null });
const completedAttachment = attachmentTable.create({
	title: 'file',
	audio: new Blob(['audio']),
});
export type _CompletedAttachmentIsDurableResult = Expect<
	Equal<
		typeof completedAttachment,
		Promise<Result<RowOf<typeof attachmentFields>, AttachmentError>>
	>
>;
// @ts-expect-error: only the attachment owner can complete the cell.
attachmentTable.update('a'.repeat(24), { audio: 'audio/wav' });
// @ts-expect-error: a MIME string is completion metadata, not creation input.
attachmentTable.create({ title: 'invalid', audio: 'audio/wav' });
