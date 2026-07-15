/**
 * Canonical Chat Storage Tests
 *
 * Verifies async conversation creation and validated keyed-message documents.
 */

import { expect, test } from 'bun:test';
import { InstantString } from '@epicenter/field';
import type { AgentMessage } from '@epicenter/workspace/agent';
import {
	defineWorkspace,
	lockWorkspace,
	type WorkspaceDocumentRuntime,
} from '@epicenter/workspace/sqlite';
import { openStandaloneWorkspace } from '@epicenter/workspace/sqlite/bun';
import * as Y from 'yjs';
import { conversationsTable } from './index.js';

const candidate = defineWorkspace({
	appId: 'chat-sqlite-test',
	version: 1,
	tables: { conversations: conversationsTable },
});
const definition = lockWorkspace(candidate, {
	format: 'epicenter.workspace-version-lock/1',
	appId: candidate.appId,
	versions: [candidate.proposedLockEntry],
});

test('creates conversation metadata and validates finished messages', async () => {
	const documents: WorkspaceDocumentRuntime = {
		open(guid) {
			const doc = new Y.Doc({ guid });
			return {
				doc,
				[Symbol.dispose]() {
					doc.destroy();
				},
			};
		},
	};
	const workspace = await openStandaloneWorkspace<
		typeof definition.tables,
		WorkspaceDocumentRuntime
	>(definition, {
		storage: { kind: 'memory' },
		documents,
		onObserverError(error) {
			throw error;
		},
	});
	const now = InstantString.now();
	const row = await workspace.tables.conversations.create({
		title: 'New Chat',
		model: 'test-model',
		createdAt: now,
		updatedAt: now,
	});
	const messages = workspace.tables.conversations.docs.messages.open(row.id);
	await messages.whenReady;
	const message: AgentMessage = {
		id: 'message-1',
		role: 'user',
		createdAt: 1,
		parts: [{ type: 'text', text: 'hello' }],
	};

	messages.content.set(message.id, message);
	expect(messages.content.get(message.id)).toEqual(message);
	expect(() =>
		messages.content.set('invalid', {
			...message,
			role: 'system',
		} as unknown as AgentMessage),
	).toThrow('does not match its schema');

	messages[Symbol.dispose]();
	await workspace[Symbol.asyncDispose]();
});
