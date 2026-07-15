/**
 * Legacy Yjs-record conversation storage for consumers that have not moved to
 * the versioned SQLite workspace yet. New code imports `@epicenter/chat`.
 */

import { field } from '@epicenter/field';
import {
	attachRecords,
	type ConnectedTables,
	defineTable,
	type InferTableRow,
} from '@epicenter/workspace';
import type { AgentMessage } from '@epicenter/workspace/agent';
import type { ConversationId } from './index.js';

export {
	asConversationId,
	type ConversationId,
	generateConversationId,
} from './index.js';

export const conversationsTable = defineTable({
	id: field.string<ConversationId>(),
	title: field.string(),
	model: field.string(),
	createdAt: field.instant(),
	updatedAt: field.instant(),
}).docs({ messages: (ydoc) => attachRecords<AgentMessage>(ydoc) });

export type Conversation = InferTableRow<typeof conversationsTable>;

export type ConversationsTable = ConnectedTables<{
	conversations: typeof conversationsTable;
}>['conversations'];
