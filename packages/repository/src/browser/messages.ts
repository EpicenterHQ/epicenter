/**
 * What tabs and the leader's worker say on a repository's BroadcastChannel.
 * Every tab, the leader's own included, talks to the worker the same way: a
 * call carries the tab's id and a call id, and a write's call id is its
 * command id, which the engine stores with its outbox rows.
 */
import type { Result } from 'wellcrafted/result';
import type { Settled, WriteError } from '../define.js';
import type { EngineRequest, WriteOp } from '../engine/engine.js';

/** Repository names become an OPFS directory, a VFS name and a lock name. */
export const REPOSITORY_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export const channelName = (name: string) => `epicenter-repository:${name}`;
export const lockName = (name: string) => `epicenter-repository:${name}`;

/** What the worker needs of the app: its templates and field names, never its schemas. */
export type Described = Record<string, { path: string; fields: string[] } | { path: string; blob: { types: string[]; maxSize?: number } }>;

/** The first message a leader tab sends its new worker. */
export type Init = {
	type: 'init';
	name: string;
	definitions: Described;
	server: { url: string } | null;
};

export type TabMessage =
	/** A new tab asks who leads. */
	| { type: 'hello' }
	| { type: 'read'; tab: string; id: string; request: EngineRequest }
	| { type: 'submit'; tab: string; id: string; ops: WriteOp[] }
	/**
	 * Fault injection for tests: the leader keeps applying writes but answers
	 * none, as a leader whose tab closes between applying and answering.
	 */
	| { type: 'test:drop-submit-answers' };

export type LeaderMessage =
	/** The worker has the database open and answers calls. Each worker has a new id. */
	| { type: 'leader'; leader: string }
	| { type: 'answer'; tab: string; id: string; value: unknown }
	| { type: 'failed'; tab: string; id: string; reason: string }
	| { type: 'local'; tab: string; id: string; result: Result<undefined, WriteError> }
	| { type: 'settled'; tab: string; id: string; result: Result<Settled[], WriteError> }
	| { type: 'changed'; paths: string[] }
	/** The leader could not open the database; no tab can use the repository. */
	| { type: 'unavailable'; reason: string };
