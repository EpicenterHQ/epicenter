/**
 * The Query workspace: the host's own durable data, today just the
 * canonical conversations table (ADR-0055). The host connects it with
 * `connect(null, { persistence })` beside the built-in app replicas, so
 * transcripts are durable on this machine but never reach a relay; sync is a
 * deliberate later wave that arrives with host sign-in.
 *
 * Exported so tests (and later waves) can open a second replica over the same
 * data directory and read what the host wrote.
 */

import { conversationsTable } from '@epicenter/chat/legacy';
import { defineWorkspace } from '@epicenter/workspace';

export const queryWorkspace = defineWorkspace({
	id: 'epicenter-query',
	name: 'query',
	tables: { conversations: conversationsTable },
	kv: {},
});
