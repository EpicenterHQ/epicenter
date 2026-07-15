/**
 * Agent Chat State Tests
 *
 * Verifies that the shared state waits for an async SQLite conversation table,
 * creates the first conversation, and does not require a legacy hydration
 * promise.
 */

import { expect, test } from 'bun:test';
import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import { conversationsTable } from '@epicenter/chat';
import {
	defineWorkspace,
	lockWorkspace,
	type WorkspaceDocumentRuntime,
} from '@epicenter/workspace/sqlite';
import { openStandaloneWorkspace } from '@epicenter/workspace/sqlite/bun';
import * as Y from 'yjs';
import { createAgentChatState } from './agent-chat.svelte.js';

(globalThis as unknown as { $state: unknown }).$state = <T>(value: T) => value;
(globalThis as unknown as { $derived: unknown }).$derived = Object.assign(
	<T>(value: T) => value,
	{ by: <T>(derive: () => T) => derive() },
);

const candidate = defineWorkspace({
	appId: 'agent-chat-state-test',
	version: 1,
	tables: { conversations: conversationsTable },
});
const definition = lockWorkspace(candidate, {
	format: 'epicenter.workspace-version-lock/1',
	appId: candidate.appId,
	versions: [candidate.proposedLockEntry],
});

test('whenReady creates the first SQLite conversation', async () => {
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
	const workspace = await openStandaloneWorkspace(definition, {
		storage: { kind: 'memory' },
		documents,
		onObserverError(error) {
			throw error;
		},
	});
	const connections = createInferenceConnections({
		storageKey: 'agent-chat-state-test',
		hostedModels: [],
		hosted: {
			baseURL: 'https://api.invalid',
			fetch: globalThis.fetch,
		},
		persist: (_key, _schema, defaultValue) => ({ current: defaultValue }),
	});
	const state = createAgentChatState({
		table: workspace.tables.conversations,
		connections,
		agent: {
			buildSystemPrompts: () => [],
			defaultModel: 'test-model',
		},
	});

	await state.whenReady;

	const rows = await workspace.tables.conversations.list();
	expect(rows).toHaveLength(1);
	const row = rows[0];
	if (!row) throw new Error('Expected the first conversation');
	expect(row.model).toBe('test-model');
	expect(state.activeConversationId).toBe(row.id);

	state[Symbol.dispose]();
	await workspace[Symbol.asyncDispose]();
});
