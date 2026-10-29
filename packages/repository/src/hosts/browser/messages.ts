/**
 * What the owning tab and its replica worker say to each other. The worker
 * belongs to that one tab and dies with it, so a call needs only an id
 * within the tab: nothing is resent, and nothing outlives the pair. Calls
 * name a method of the worker's `ReplicaMethods`; their values cross as
 * structured clones, so a blob goes up as a `Blob` and comes back as a
 * `File`, and an error's `cause` crosses as its message.
 */
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import type { Manifest } from './layout.js';
import type { ReplicaMethods } from './worker.js';

/** What a tab's save can come back as instead of stored. */
export const SaveError = defineErrors({
	/** The device's storage is full: nothing of the save was stored. */
	QuotaExceeded: () => ({ message: 'This device has no room left, so the save was not stored' }),
	/** Storage failed for another reason: nothing of the save was stored. */
	Failed: ({ reason }: { reason: string }) => ({ message: `The save was not stored: ${reason}`, reason }),
	/** The replica closed in this tab (another tab took it, or the page hid) before the save reached it. */
	Closed: () => ({ message: 'The replica is not open in this tab' }),
});
export type SaveError = InferErrors<typeof SaveError>;

/** An app's view, as the worker installs it: its name and SQL. */
export type View = { name: string; view: string };

/** The first message a tab sends its new worker. */
export type Init = {
	type: 'init';
	replica: string;
	/** A new replica's manifest, written when the replica has none. */
	create: Manifest | null;
	views: View[];
	/** Sent with the server's HTTP requests, such as `authorization`; the socket gets a ticket with them. */
	headers: Record<string, string>;
};

export type Call = { [TMethod in keyof ReplicaMethods]: { type: 'call'; id: number; method: TMethod; args: Parameters<ReplicaMethods[TMethod]> } }[keyof ReplicaMethods];

export type TabMessage =
	| Init
	| Call
	/**
	 * Finish every call sent before this one, close the database and the
	 * socket, release the storage, and answer `closed`. Calls apply in the
	 * order they arrive, so the last keystroke a tab sent is saved first.
	 */
	| { type: 'close' };

export type WorkerMessage =
	/** Another worker still holds the replica's database; this one keeps trying until it lets go. */
	| { type: 'waiting'; reason: string }
	/** The database is open and calls are answered. */
	| { type: 'ready'; manifest: Manifest }
	/** There is no such replica here, or its removal has begun. */
	| { type: 'missing' }
	/** This browser cannot open the replica, for a reason waiting would not fix. */
	| { type: 'unavailable'; reason: string }
	| { type: 'answer'; id: number; value: unknown }
	| { type: 'failed'; id: number; reason: string }
	/** These paths' text or state changed, and the change is stored. */
	| { type: 'changed'; paths: string[] }
	/** The database is closed and its storage released. */
	| { type: 'closed' };
