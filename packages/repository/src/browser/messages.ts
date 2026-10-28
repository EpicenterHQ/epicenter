/**
 * What the owning tab and its worker say to each other. The worker belongs
 * to that one tab and dies with it, so a call needs only an id within the
 * tab: nothing is resent, and nothing outlives the pair.
 */
import type { Result } from 'wellcrafted/result';
import type { Settled, WriteError } from '../define.js';
import type { EngineRequest, WriteOp } from '../engine/engine.js';

/** Repository names become an OPFS directory, a VFS name and a lock name. */
export const REPOSITORY_NAME = /^[A-Za-z0-9_-]{1,64}$/;

/** The Web Lock a tab holds while its worker may hold the repository's database. */
export const lockName = (name: string) => `epicenter-repository:${name}`;

/** What the worker needs of the app: its templates and field names, never its schemas. */
export type Described = Record<string, { path: string; fields: string[] } | { path: string; blob: { types: string[]; maxSize?: number } }>;

/** The first message a tab sends its new worker. */
export type Init = {
	type: 'init';
	name: string;
	definitions: Described;
	server: { url: string } | null;
};

export type TabMessage =
	| Init
	| { type: 'read'; id: number; request: EngineRequest }
	| { type: 'submit'; id: number; ops: WriteOp[] }
	/**
	 * Finish every call sent before this one, close the database, release
	 * its storage, and answer `closed`. Writes apply in the order they
	 * arrive, so the last keystroke a tab sent is saved before the close.
	 */
	| { type: 'close' };

export type WorkerMessage =
	/** Another worker still holds the database; this one keeps trying until it lets go. */
	| { type: 'waiting'; reason: string }
	/** The database is open and calls are answered. */
	| { type: 'ready' }
	/** This browser cannot hold the repository at all. */
	| { type: 'unavailable'; reason: string }
	| { type: 'answer'; id: number; value: unknown }
	| { type: 'failed'; id: number; reason: string }
	| { type: 'local'; id: number; result: Result<undefined, WriteError> }
	| { type: 'settled'; id: number; result: Result<Settled[], WriteError> }
	| { type: 'changed'; paths: string[] }
	/** The database is closed and its storage released. */
	| { type: 'closed' };
