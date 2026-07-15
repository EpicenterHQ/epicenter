/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Connects a Yjs document to the relay and derives per-peer liveness from the
 * server-owned presence channel.
 *
 * Two wire surfaces ride one auth context:
 *
 *   binary WS frames  -> standard y-protocols SYNC.
 *   text WS frames    -> server -> client: presence (the full peer list, sent on
 *                        every membership change);
 *                        client -> server: presence_publish (this node's
 *                        identity: agent designation), sent once per connect.
 *
 * The Y.Doc holds durable workspace state; presence lives on the relay's
 * `connections` map. Actions live on the workspace bundle, not collaboration.
 */

import type { Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import {
	createSyncSupervisor,
	type OpenWebSocketFn,
} from './internal/sync-supervisor.js';
import {
	checkPresenceFrame,
	type Peer,
	type PresencePublishFrame,
} from './presence-protocol.js';

// ════════════════════════════════════════════════════════════════════════════
// PUBLIC TYPES
// ════════════════════════════════════════════════════════════════════════════

/**
 * Re-exported from the sync supervisor (its sole declaration) so consumers
 * keep importing `OpenWebSocketFn` from `open-collaboration` while the type has
 * one home. See {@link OpenWebSocketFn} for the contract.
 */
export type { OpenWebSocketFn };

/**
 * Subscribe to a wake signal that should trigger a sync reconnect (e.g. an
 * auth-state transition that may have refreshed the bearer). The callback
 * receives no argument and returns an unsubscribe. Pass `auth.onStateChange`
 * or any compatible function.
 */
export type OnReconnectSignal = (fn: () => void) => () => void;

export type OpenCollaborationConfig = {
	/**
	 * WebSocket URL the supervisor connects to, used verbatim. Callers
	 * build it via {@link roomWsUrl} (or any custom builder); the wire
	 * `?nodeId=` query that the relay routes by lives in this URL.
	 * `openCollaboration` does not parse, mutate, or augment it.
	 */
	url: string;
	/**
	 * Opens the relay socket. Pass `auth.openWebSocket` or any function
	 * with the same shape; the supervisor calls this on every connect and
	 * reconnect.
	 */
	openWebSocket: OpenWebSocketFn;
	/**
	 * Subscribe to a wake signal that should trigger a reconnect (token refresh,
	 * sign-in after reauth-required, sign-out then sign-in). Pass
	 * `auth.onStateChange` or any compatible function. The unsubscribe is wired
	 * into `whenDisposed`, so callers do not write reconnect glue.
	 */
	onReconnectSignal: OnReconnectSignal;
	waitFor?: Promise<unknown>;
	/**
	 * Optional deadline for the FIRST sync handshake. When set, the returned
	 * `whenConnected` rejects if STEP2/UPDATE does not land within this many ms.
	 * The supervisor keeps retrying regardless; only this handle's `whenConnected`
	 * view rejects. Omit for long-lived docs (the root doc) that should wait
	 * indefinitely; set it for one-shot reads that must give up if a room stalls.
	 */
	connectDeadlineMs?: number;
	log?: Logger;
	/**
	 * The catalog agent this peer answers as (ADR-0025), published in presence so
	 * peers can see which agent ids are live. Set only by a long-lived agent
	 * process; omit for ordinary participants and content docs.
	 */
	agentId?: string;
};

// ════════════════════════════════════════════════════════════════════════════
// IMPLEMENTATION
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reject `whenConnected` if the first handshake has not landed within
 * `deadlineMs`. Decorates the supervisor's one-shot promise without touching its
 * retry loop; the timer clears as soon as the underlying promise settles, so a
 * fast connect leaves no dangling handle. The caller tears the doc down on
 * rejection (e.g. `ydoc.destroy()`).
 */
function withConnectDeadline(
	whenConnected: Promise<void>,
	deadlineMs: number,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	return Promise.race([
		whenConnected,
		new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(new Error(`sync handshake exceeded ${deadlineMs}ms`));
			}, deadlineMs);
		}),
	]).finally(() => {
		if (timer !== undefined) clearTimeout(timer);
	});
}

export function openCollaboration(
	ydoc: Y.Doc,
	config: OpenCollaborationConfig,
) {
	// Server-owned presence: the relay pushes the full peer list as a
	// `presence` text frame on every membership or identity change. Each entry
	// carries the peer's nodeId, connectedAt, and optional identity fields. The
	// client stores the latest list and notifies subscribers;
	// there is no delta protocol and no client-side reassembly. The relay
	// dedupes multi-tab same-node (newest-wins by connectedAt) and excludes
	// the receiver's own node, so the client stores `peers` verbatim.
	let remotePeers: Peer[] = [];
	const presenceListeners = new Set<(peers: Peer[]) => void>();

	// Store the latest peer list from a recognized `presence` frame; ignore
	// any other text frame.
	function handlePresenceFrame(text: string): void {
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			return;
		}
		if (!checkPresenceFrame.Check(parsed)) return;
		remotePeers = parsed.peers;
		for (const listener of presenceListeners) listener(remotePeers);
	}

	// This node publishes only its identity in presence. Actions stay local; the
	// wire carries no action manifest (ADR-0073 deleted the in-room dispatch
	// subsystem).
	const presencePublishFrame = JSON.stringify({
		type: 'presence_publish',
		agentId: config.agentId,
	} satisfies PresencePublishFrame);

	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket: config.openWebSocket,
		log: config.log,
		// Text frames carry the server-owned presence channel.
		onTextFrame(text) {
			handlePresenceFrame(text);
		},
	});

	const unsubscribeStatusListener = supervisor.onStatusChange((status) => {
		// Publish this node's presence identity on every (re)connect. The relay
		// stores it against the new socket and rebroadcasts presence so peers see it.
		if (status.phase === 'connected') {
			supervisor.send(presencePublishFrame);
		}
	});

	// Reconnect wake: tell the live socket to retry whenever the caller signals
	// that credentials may have changed. Today the only producer is
	// `auth.onStateChange` (token refresh, reauth-required to signed-in,
	// sign-in after sign-out); the supervisor's own state machine decides
	// whether the reconnect actually does anything.
	const unsubscribeReconnectSignal = config.onReconnectSignal(() => {
		supervisor.reconnect();
	});

	void supervisor.whenDisposed.then(() => {
		unsubscribeStatusListener();
		unsubscribeReconnectSignal();
	});

	// `peers` reads the latest relay-pushed presence list directly.
	const peers = {
		list(): Peer[] {
			return remotePeers;
		},
		subscribe(fn: (peers: Peer[]) => void): () => void {
			presenceListeners.add(fn);
			return () => {
				presenceListeners.delete(fn);
			};
		},
	};

	// A connect deadline is a one-shot, caller-scoped view: only this handle's
	// `whenConnected` rejects after the deadline; the supervisor keeps retrying.
	const whenConnected =
		config.connectDeadlineMs === undefined
			? supervisor.whenConnected
			: withConnectDeadline(supervisor.whenConnected, config.connectDeadlineMs);

	return {
		/** Current sync lifecycle status. */
		get status() {
			return supervisor.status;
		},
		/** Resolves after the first successful sync handshake. */
		whenConnected,
		/** Resolves after document destroy tears down collaboration. */
		whenDisposed: supervisor.whenDisposed,
		/** Subscribe to sync status changes. Returns an unsubscribe function. */
		onStatusChange: supervisor.onStatusChange,
		/** Restart the current connection cycle. */
		reconnect: supervisor.reconnect,
		/**
		 * Online peers in this workspace, derived from the server-owned
		 * presence channel.
		 */
		get peers() {
			return peers;
		},
		/** Destroy the Y.Doc, cascading teardown to attached primitives. */
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type Collaboration = ReturnType<typeof openCollaboration>;
