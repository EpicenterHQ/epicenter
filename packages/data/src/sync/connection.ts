/**
 * The half of a connection that is correctness, over the half that is a socket.
 *
 * `createSyncClient` deliberately owns no socket, and that is worth keeping:
 * every timing rule in it is testable without a network, which is not a
 * hypothetical benefit here, because a cursor rule on this branch once "worked"
 * in a simulation where nothing was ever delivered. Socket CONSTRUCTION also
 * genuinely differs per host: a browser origin builds a URL and carries a
 * cookie, a desktop window carries a bearer, a lab page carries neither.
 *
 * What was not legitimate is that the rules for DRIVING that socket lived in
 * each host's own copy of a connect loop. Reconnecting when the client reports
 * `needsResync` is one of them, and it is a correctness requirement rather than
 * a nicety: a randomised schedule wedged a device at position 108 while it kept
 * receiving 118, 119 and 121 and rejecting every one, with no error surfaced
 * anywhere and the socket perfectly healthy. A rule like that cannot be
 * something each application remembers.
 *
 * So the split is: the host says HOW to make a socket, and this file says what
 * to do with one. `createSyncClient` is unchanged underneath.
 *
 * ## What this owns
 *
 * - The cursor goes into every dial, read fresh, so a reconnect is always a
 *   catch-up from what this replica has applied.
 * - Attach on open, feed on message, detach on close.
 * - Reconnect when the socket closes, with backoff.
 * - Reconnect when the client reports `needsResync`, which is the repair for a
 *   gap and for a broken chunk stream alike.
 * - Reconnect when a submission goes unacknowledged for too long. This is the
 *   cheap answer to the production stall recorded in
 *   `evidence/workerd/results.md`: a sustained run against Cloudflare stopped
 *   waiting for an acknowledgement, four hypotheses were tested and none was
 *   it. A watchdog makes it self-healing whatever the cause turns out to be,
 *   which is worth more than the diagnosis.
 * - Nudging on local work, by subscribing to the store rather than by asking
 *   every caller to remember.
 * - Reporting a credential refusal as data on the status, and dialling again
 *   on the same backoff. A refusal is decided locally, before anything reaches
 *   the wire: the host has no credential, or the one it has was already
 *   refused. So a retry capped at thirty seconds costs a status read, and the
 *   dial after a person signs back in simply succeeds. This driver runs for as
 *   long as the store is open and has no parked state to resume from.
 *
 * Everything else is ordinary weather: a close, garbage on the wire, and every
 * failure reconnect on backoff. Nothing this driver sees can discard local
 * state, which is what makes "doubt never discards" structural rather than
 * careful.
 */
import type { SyncRefusal } from '@epicenter/sync/transport';
import { Ok, type Result } from 'wellcrafted/result';

import { type DataDocument, syncEngineOf } from '../store/store.js';
import {
	createSyncClient,
	type Schedule,
	type SyncClient,
	type SyncClientError,
	type SyncClientStatus,
	type SyncSocket,
} from './client.js';

/**
 * One attempt at a connection, from the host's point of view.
 *
 * The host is handed the position to ask from and three callbacks, and hands
 * back whatever tears its socket down. Every callback is safe to call from a
 * stale attempt: this file checks, so a host does not have to.
 */
export type SyncAttempt = {
	/**
	 * The position to ask the authority to start after. Belongs in the URL.
	 *
	 * Read fresh on every attempt from what this replica has applied, which is
	 * what makes a reconnect a catch-up rather than a fresh start. At boot
	 * that is exactly what the durable record recovered; mid-session it may
	 * run ahead of a blocked durable copy, and a restart then re-fetches from
	 * the applied cursor, which is safe because an update is idempotent
	 * (ADR-0238).
	 */
	readonly cursor: number;
	/** The socket is live and can carry bytes. */
	opened(socket: SyncSocket): void;
	/** Bytes arrived from the authority. */
	received(bytes: Uint8Array): void;
	/**
	 * The socket is gone, for any reason. Safe to call more than once.
	 *
	 * `refusal` says the host's credential model declined to open one at all,
	 * and which refusal it was. It is reported rather than raised, and it does
	 * not stop anything: the driver records it on its status for a surface to
	 * render, then dials again on the ordinary backoff. That retry is free
	 * because a refusal is decided locally, with no request on the wire, so
	 * nothing has to wake this driver when a credential arrives.
	 */
	closed(refusal?: SyncRefusal): void;
};

/**
 * How this host makes a socket. The whole of what a host has to write.
 *
 * Returns a teardown. It is called when this driver has decided to abandon the
 * attempt, and it must be safe to call on a socket that already closed.
 */
export type SyncDial = (attempt: SyncAttempt) => () => void;

/** Why the driver last decided to reconnect. Diagnostic, never control flow. */
export type ReconnectReason =
	/** The socket closed, whether cleanly or not. */
	| 'closed'
	/** The client is stuck behind a gap and asked to be reconnected. */
	| 'resync'
	/** A submission went unacknowledged past the watchdog's patience. */
	| 'stalled'
	/** The host's credential model refused to open a socket. */
	| 'refused';

export type SyncConnectionStatus = SyncClientStatus & {
	/** Whether a socket is currently attached. */
	connected: boolean;
	/**
	 * Why the host's credential model refused the last dial, if it did.
	 *
	 * Set on a refused dial and cleared by the next dial that is not refused,
	 * whether that one opens or fails on the wire: it describes the last dial's
	 * outcome rather than a history. So a signed-in person who is merely
	 * offline never reads a line about signing in. A surface maps it
	 * exhaustively and renders nothing for the arms a person cannot act on.
	 */
	refusal: SyncRefusal | undefined;
	/**
	 * Failed dials since the last one that stayed up long enough to count.
	 *
	 * What the backoff is computed from, and the one number that says "this
	 * device is not talking to anything" without needing an error to have been
	 * produced. Under a standing refusal it climbs for the life of the store,
	 * which is why a surface showing a refusal does not also show this.
	 */
	failures: number;
	/** Why the last reconnect happened, or undefined if none has. */
	lastReconnect: ReconnectReason | undefined;
};

export type SyncConnection = {
	/** Start dialling. Idempotent. */
	start(): void;
	/** Send whatever is owed, now, rather than on the idle timer. */
	flush(): Result<void, SyncClientError>;
	status(): SyncConnectionStatus;
	/** Stop dialling and let go of the socket. */
	[Symbol.dispose](): void;
};

/**
 * The default backoff: double from a second, capped at half a minute.
 *
 * Capped rather than unbounded because the thing on the other end is a Durable
 * Object that hibernates and wakes, so "unreachable" is routinely a few seconds
 * rather than an outage, and a replica that has backed off to minutes would sit
 * out a recovery that already happened.
 */
function defaultBackoff(failures: number): number {
	return Math.min(30_000, 1_000 * 2 ** Math.max(0, failures - 1));
}

export function createSyncConnection({
	store,
	dial,
	idleMs,
	schedule = (task, delayMs) => {
		const handle = setTimeout(task, delayMs);
		return () => clearTimeout(handle);
	},
	backoff = defaultBackoff,
	/**
	 * How long a socket must stay up before it counts as a working connection.
	 *
	 * The backoff resets here rather than on `opened`, and the difference
	 * matters: a server that accepts the upgrade and immediately closes, which
	 * is what a rejected credential or an overloaded authority looks like, would
	 * otherwise reset the backoff on every attempt and turn it into a hot loop.
	 */
	healthyMs = 5_000,
	/**
	 * How long one submission may stay unacknowledged before the socket is
	 * treated as dead.
	 *
	 * Generous on purpose. The failure it catches is a submission that will
	 * never be answered, not a slow one, and the cost of being wrong is a
	 * reconnect that re-sends bytes the authority may already hold, which is
	 * free: an update is idempotent (`evidence/invariants.test.ts`).
	 */
	unacknowledgedMs = 30_000,
}: {
	store: DataDocument;
	dial: SyncDial;
	idleMs?: number;
	schedule?: Schedule;
	backoff?: (failures: number) => number;
	healthyMs?: number;
	unacknowledgedMs?: number;
}): SyncConnection {
	const client: SyncClient = createSyncClient({
		store,
		...(idleMs === undefined ? {} : { idleMs }),
		schedule,
	});

	let running = false;
	let disposed = false;
	let connected = false;
	let refusal: SyncRefusal | undefined;
	let failures = 0;
	let lastReconnect: ReconnectReason | undefined;
	/**
	 * Which attempt is the live one.
	 *
	 * Every callback a host holds carries the attempt it was made for. A socket
	 * that closes after this driver has already moved on would otherwise detach
	 * the client from its replacement, which reads as a connection that silently
	 * stops carrying anything.
	 */
	let attempt = 0;
	let teardown: (() => void) | undefined;
	let cancelRedial: (() => void) | undefined;
	let cancelHealthy: (() => void) | undefined;
	let cancelWatchdog: (() => void) | undefined;
	/** The submission the watchdog saw on its previous tick. */
	let watched: number | undefined;

	const stopSendable = syncEngineOf(store).onSendable(() => client.nudge());

	function cancelTimers(): void {
		cancelHealthy?.();
		cancelHealthy = undefined;
		cancelWatchdog?.();
		cancelWatchdog = undefined;
		watched = undefined;
	}

	/** Let go of the current socket, whatever state it is in. */
	function abandon(): void {
		attempt += 1;
		cancelTimers();
		const stop = teardown;
		teardown = undefined;
		connected = false;
		client.detach();
		stop?.();
	}

	/**
	 * Abandon the current socket and dial again after the backoff.
	 *
	 * One path for all three reasons, because the repair is the same one in
	 * every case: ask the authority for everything after this replica's own
	 * cursor, which is the catch-up any returning device runs.
	 */
	function reconnect(reason: ReconnectReason): void {
		if (!running) return;
		lastReconnect = reason;
		abandon();
		failures += 1;
		cancelRedial?.();
		cancelRedial = schedule(() => {
			cancelRedial = undefined;
			open();
		}, backoff(failures));
	}

	/**
	 * Everything to check after the client has been handed something.
	 *
	 * `needsResync` is the reason this exists and the reason it runs after every
	 * single delivery rather than on a timer: the client sets it and then waits
	 * for someone to notice, and a randomised schedule showed that nobody does.
	 */
	function settle(): void {
		if (!running) return;
		if (client.status().needsResync) reconnect('resync');
	}

	/** Let go of everything, permanently. Disposal, and nothing else. */
	function shutdown(): void {
		running = false;
		stopSendable();
		cancelRedial?.();
		cancelRedial = undefined;
		abandon();
		client.dispose();
	}

	function open(): void {
		if (!running || teardown !== undefined) return;
		const dialled = ++attempt;
		const live = () => running && attempt === dialled;

		teardown = dial({
			cursor: client.cursor(),
			opened(socket: SyncSocket) {
				if (!live()) return;
				connected = true;
				// This dial was not refused, so whatever refused the one before it
				// is no longer what happened.
				refusal = undefined;
				client.attach(socket);
				// A socket that lasts is what proves the far end works. Anything
				// shorter is an attempt that failed in a way that happens to include
				// a successful upgrade.
				cancelHealthy = schedule(() => {
					cancelHealthy = undefined;
					failures = 0;
				}, healthyMs);
				startWatchdog();
				settle();
			},
			received(bytes: Uint8Array) {
				if (!live()) return;
				client.receive(bytes);
				settle();
			},
			closed(refused?: SyncRefusal) {
				if (!live()) return;
				// Assigned rather than merged, so a dial that reached the wire
				// clears a refusal the one before it reported. The status answers
				// for the last dial, and an offline signed-in device must not be
				// told to sign in.
				refusal = refused;
				reconnect(refused === undefined ? 'closed' : 'refused');
			},
		});
		// The attempt may have ended during dial() itself: a host that fails
		// synchronously reports `closed` before the teardown above is assigned,
		// so the abandonment already ran and this assignment would otherwise
		// resurrect a dead attempt and block every future redial.
		if (attempt !== dialled) {
			const stop = teardown;
			teardown = undefined;
			stop?.();
		}
	}

	/**
	 * Watch for a submission that is never going to be answered.
	 *
	 * It compares the submission NUMBER across ticks rather than the `inFlight`
	 * flag. Only one submission is ever out and the next starts the moment the
	 * previous is acknowledged, so under sustained local work the flag is
	 * continuously true on a completely healthy client, and a watchdog reading
	 * it would reconnect a working device every interval.
	 */
	function startWatchdog(): void {
		const tick = () => {
			cancelWatchdog = undefined;
			if (!running || !connected) return;
			const submission = client.status().inFlightSubmission;
			if (submission !== undefined && submission === watched) {
				watched = undefined;
				reconnect('stalled');
				return;
			}
			watched = submission;
			cancelWatchdog = schedule(tick, unacknowledgedMs);
		};
		watched = client.status().inFlightSubmission;
		cancelWatchdog = schedule(tick, unacknowledgedMs);
	}

	return Object.freeze({
		start() {
			if (disposed || running) return;
			running = true;
			open();
		},

		flush() {
			if (disposed) return Ok(undefined);
			return client.flush();
		},

		status(): SyncConnectionStatus {
			return {
				...client.status(),
				connected,
				refusal,
				failures,
				lastReconnect,
			};
		},

		[Symbol.dispose]() {
			if (disposed) return;
			disposed = true;
			shutdown();
		},
	});
}
