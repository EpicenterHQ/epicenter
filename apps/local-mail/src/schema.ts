import { type Static, Type } from 'typebox';

/**
 * The Gmail mirror's wire shapes, as typebox schemas: `gmail-client.ts`
 * validates every network response against these before it reaches `sync.ts`
 * or `db.ts`, the same boundary-validation idiom `tokens.ts` already uses for
 * the OAuth grant response. `apps/local-books`' `entities.ts` is a registry
 * over ~15 uniformly-shaped, user-configurable QuickBooks entity types, which
 * earns a generic `EntityDef` abstraction. Gmail has a small fixed set of
 * wire shapes, nothing to configure, so `db.ts` declares each table directly
 * instead of building a registry.
 *
 * No schema sets `additionalProperties: false`: these describe only the
 * fields this package actually reads (Gmail messages carry many more, e.g.
 * `payload.parts`/`payload.body`/`sizeEstimate`), so an unread field must
 * never fail validation. `db.ts` stores the full original parsed object as
 * `raw` (via `JSON.stringify`), not a schema-narrowed copy: `Value.Check` is
 * a non-mutating predicate, it never strips unknown properties.
 */

/**
 * Gmail's system label ids. These are protocol constants, not mailbox data:
 * Gmail assigns them, they are identical in every account, and unlike a user
 * label they can be neither renamed nor deleted (Gmail API reference, verified
 * 2026-08-01). Knowing them is what lets triage work before the first pull and
 * across a mirror rebuild, when the mirrored label table is empty but archiving
 * still has an unambiguous meaning.
 *
 * `CATEGORY_*` are included because Gmail's inbox tabs are system labels a user
 * can legitimately act on. Custom labels are `Label_<n>` and are NOT here: their
 * ids and names are account data, so they resolve against the mirror.
 */
export const GMAIL_SYSTEM_LABEL_IDS = new Set([
	'INBOX',
	'SENT',
	'DRAFT',
	'SPAM',
	'TRASH',
	'UNREAD',
	'STARRED',
	'IMPORTANT',
	'CHAT',
	'CATEGORY_PERSONAL',
	'CATEGORY_SOCIAL',
	'CATEGORY_PROMOTIONS',
	'CATEGORY_UPDATES',
	'CATEGORY_FORUMS',
]);

/** Gmail routes trash through its own endpoints rather than a label delta, so
 * this one id is special at delivery. It is an ordinary label everywhere else. */
export const TRASH_LABEL_ID = 'TRASH';

/** One Gmail message resource. `messages.get(format=full)` populates every
 * field; a `history.list` record's embedded `message` is thinner (id/threadId/
 * labelIds only, per the Gmail History API), which is why every field past
 * `id`/`threadId` is optional here, not because the full resource lacks them. */
export const GmailMessageSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	threadId: Type.String({ minLength: 1 }),
	labelIds: Type.Optional(Type.Array(Type.String())),
	snippet: Type.Optional(Type.String()),
	internalDate: Type.Optional(Type.String()),
	payload: Type.Optional(
		Type.Object({
			mimeType: Type.Optional(Type.String()),
			body: Type.Optional(
				Type.Object({
					data: Type.Optional(Type.String()),
				}),
			),
			headers: Type.Optional(
				Type.Array(Type.Object({ name: Type.String(), value: Type.String() })),
			),
			parts: Type.Optional(Type.Array(Type.Any())),
		}),
	),
});
export type GmailMessage = Static<typeof GmailMessageSchema>;

/** One Gmail label resource, as returned by `labels.list`. */
export const GmailLabelSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	name: Type.String({ minLength: 1 }),
	type: Type.String({ minLength: 1 }),
});
export type GmailLabel = Static<typeof GmailLabelSchema>;

/** One `history.list` entry. Four mutually-exclusive record types; a
 * `labelsAdded`/`labelsRemoved` entry's `message.labelIds` is the full CURRENT
 * snapshot, its own `labelIds` field is the delta (see `sync.ts`'s
 * `foldHistoryRecords`, which intentionally uses only the former). */
export const HistoryRecordSchema = Type.Object({
	id: Type.String({ minLength: 1 }),
	messagesAdded: Type.Optional(
		Type.Array(Type.Object({ message: GmailMessageSchema })),
	),
	messagesDeleted: Type.Optional(
		Type.Array(Type.Object({ message: GmailMessageSchema })),
	),
	labelsAdded: Type.Optional(
		Type.Array(
			Type.Object({
				message: GmailMessageSchema,
				labelIds: Type.Array(Type.String()),
			}),
		),
	),
	labelsRemoved: Type.Optional(
		Type.Array(
			Type.Object({
				message: GmailMessageSchema,
				labelIds: Type.Array(Type.String()),
			}),
		),
	),
});
export type HistoryRecord = Static<typeof HistoryRecordSchema>;

/** A page of `history.list`. No `history` key at all (not an empty array)
 * means nothing changed; `Type.Optional` (an absent property) models that
 * directly, rather than a nullable/empty-array convention. */
export const HistoryPageSchema = Type.Object({
	history: Type.Optional(Type.Array(HistoryRecordSchema)),
	historyId: Type.String({ minLength: 1 }),
	nextPageToken: Type.Optional(Type.String()),
});
export type HistoryPage = Static<typeof HistoryPageSchema>;

export const ListMessageIdsResponseSchema = Type.Object({
	messages: Type.Optional(
		Type.Array(Type.Object({ id: Type.String({ minLength: 1 }) })),
	),
	nextPageToken: Type.Optional(Type.String()),
});

export const ListLabelsResponseSchema = Type.Object({
	labels: Type.Optional(Type.Array(GmailLabelSchema)),
});

export const ProfileResponseSchema = Type.Object({
	historyId: Type.String({ minLength: 1 }),
	emailAddress: Type.Optional(Type.String({ minLength: 1 })),
});
