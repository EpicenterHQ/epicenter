/**
 * Canonical conversation storage for versioned SQLite workspace applications.
 *
 * Conversation metadata is an async table row. Finished messages live in one
 * validated keyed child document owned by that row.
 */

import { jsonValue } from '@epicenter/field';
import type { AgentMessage } from '@epicenter/workspace/agent';
import {
	defineTable,
	document,
	field,
	generateId,
	type Id,
	type OpenedDocument,
	type OpenedTable,
	type RowFor,
} from '@epicenter/workspace/sqlite';
import { Type } from 'typebox';
import type { Brand } from 'wellcrafted/brand';

/** Branded conversation id: a NanoID minted when a conversation is created. */
export type ConversationId = Id & Brand<'ConversationId'>;

/** Mint a unique {@link ConversationId}. */
export const generateConversationId = (): ConversationId =>
	generateId<ConversationId>();

/** Brand one validated or route-owned string as a conversation ID. */
export const asConversationId = (value: string): ConversationId =>
	value as ConversationId;

const agentMessageSchema = Type.Unsafe<AgentMessage>(
	Type.Object(
		{
			id: Type.String(),
			role: Type.Union([Type.Literal('user'), Type.Literal('assistant')]),
			createdAt: Type.Number(),
			parts: Type.Array(
				Type.Union([
					Type.Object(
						{ type: Type.Literal('text'), text: Type.String() },
						{ additionalProperties: false },
					),
					Type.Object(
						{
							type: Type.Literal('tool-call'),
							toolCallId: Type.String(),
							toolName: Type.String(),
							input: jsonValue,
						},
						{ additionalProperties: false },
					),
					Type.Object(
						{
							type: Type.Literal('tool-result'),
							toolCallId: Type.String(),
							toolName: Type.String(),
							content: Type.String(),
							details: Type.Optional(jsonValue),
							isError: Type.Boolean(),
						},
						{ additionalProperties: false },
					),
				]),
			),
		},
		{ additionalProperties: false },
	),
);

export const conversationMessages = document.keyed(agentMessageSchema);

export const conversationsTable = defineTable({
	fields: {
		id: field.id<ConversationId>(),
		title: field.string(),
		model: field.string(),
		createdAt: field.instant(),
		updatedAt: field.instant(),
		messages: field.doc(conversationMessages),
	},
});

export type Conversation = RowFor<typeof conversationsTable>;
export type ConversationsTable = OpenedTable<typeof conversationsTable>;
export type OpenedConversationMessages = OpenedDocument<
	typeof conversationMessages
>;
