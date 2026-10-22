/** The rows of Epicenter's local AI connections folder. */
import type { Issue } from '@epicenter/folder';
import { type Static, Type } from 'typebox';
import { Value } from 'typebox/value';

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
 * `connections`, and the keychain entries their endpoints and
 * keys are saved under. A caller names an operation; only this table names
 * a row.
 */
export const WHISPERING_CONNECTION_IDS = {
	transcription: 'whispering-transcription',
	text: 'whispering-text',
} as const;

export type WhisperingConnection = keyof typeof WHISPERING_CONNECTION_IDS;

/**
 * The fields a Whispering connection save assigns, and no others: the kind
 * it sends with, a title for a new row, and the model. A field left out
 * keeps its current value. An
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
	{ fields: ConnectionRowAssignment },
	{ additionalProperties: false },
);
export type ConnectionRowSetInput = Static<typeof ConnectionRowSetInput>;

/** Whether untrusted JSON is a `ConnectionRowSetInput`, with no other member. */
export const isConnectionRowSetInput = (
	value: unknown,
): value is ConnectionRowSetInput => Value.Check(ConnectionRowSetInput, value);

/**
 * A connection row as the CLI answers it. `fields` holds the schema's three fields when the row reads,
 * and is `null` when it does not; any other field stays in `text`.
 */
export type ConnectionRow = {
	readonly text: string;
	readonly issues: readonly Issue[] | null;
	readonly fields: Static<typeof connectionsTables.connections> | null;
};
