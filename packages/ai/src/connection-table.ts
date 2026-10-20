/** The rows of Epicenter's local AI connections folder. */
import type { Issue } from '@epicenter/folder';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

/** The shell's scope for its own connection files. */
export const CONNECTIONS_FOLDER_ID = 'so.epicenter';

/** Keychain endpoints and keys stay outside these Markdown rows. */
export const connectionsTables = {
	connections: Type.Object({
		kind: Type.Union([
			Type.Literal('openai-compatible'),
			Type.Literal('epicenter'),
			Type.Literal('local'),
		]),
		title: Type.String(),
		model: Type.String(),
	}),
};

/**
 * Whispering's two connections, by operation: the stems of their rows in
 * `so.epicenter/connections`, and the keychain entries their endpoints and
 * keys are saved under. A caller names an operation; only this table names
 * a row.
 */
export const WHISPERING_CONNECTION_IDS = {
	transcription: 'whispering-transcription',
	text: 'whispering-text',
} as const;

export type WhisperingConnection = keyof typeof WHISPERING_CONNECTION_IDS;

/** Why a row does not read as a connection, as `@epicenter/folder` reports it. */
const ConnectionRowIssue = Type.Object(
	{
		kind: Type.Union([
			Type.Literal('not-text'),
			Type.Literal('frontmatter'),
			Type.Literal('schema'),
		]),
		message: Type.String(),
		path: Type.Array(Type.Union([Type.String(), Type.Number()])),
		line: Type.Optional(Type.Number()),
	},
	{ additionalProperties: false },
);

/**
 * The row a save starts from, as it was read: its exact source and whether
 * it read. `null` saves a new row. The engine merges the change from this
 * source into what the file holds now, so an edit that landed since stays.
 */
const ConnectionRowBase = Type.Union([
	Type.Object(
		{
			text: Type.String(),
			issues: Type.Union([Type.Array(ConnectionRowIssue), Type.Null()]),
		},
		{ additionalProperties: false },
	),
	Type.Null(),
]);

/**
 * The fields a Whispering connection save assigns, and no others: the kind
 * it sends with, a title for a new row, and the model. A field left out
 * keeps its value, and every field another program added survives. An
 * `epicenter` or `local` row is Settings' to make.
 */
const ConnectionRowAssignment = Type.Object(
	{
		kind: Type.Optional(Type.Literal('openai-compatible')),
		title: Type.Optional(Type.String()),
		model: Type.Optional(Type.String()),
	},
	{ additionalProperties: false },
);

/** What a Whispering connection save reads on stdin. */
export const ConnectionRowSetInput = Type.Object(
	{ base: ConnectionRowBase, fields: ConnectionRowAssignment },
	{ additionalProperties: false },
);
export type ConnectionRowSetInput = Static<typeof ConnectionRowSetInput>;

/** Whether untrusted JSON is a `ConnectionRowSetInput`, with no other member. */
export const isConnectionRowSetInput = (
	value: unknown,
): value is ConnectionRowSetInput => Value.Check(ConnectionRowSetInput, value);

/**
 * A connection row as the CLI answers it. `text` and `issues` are the next
 * save's base. `fields` holds the schema's three fields when the row reads,
 * and is `null` when it does not; any other field stays in `text`.
 */
export type ConnectionRow = {
	readonly text: string;
	readonly issues: readonly Issue[] | null;
	readonly fields: Static<typeof connectionsTables.connections> | null;
};
