/**
 * `openCollaboration`: the one collaboration primitive on a document.
 *
 * Connects a Yjs document to its authenticated room relay.
 */

import type { Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';
import {
	createSyncSupervisor,
	type OpenWebSocketFn,
} from './internal/sync-supervisor.js';

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
	 * build it via {@link roomWsUrl} (or any custom builder).
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
	const supervisor = createSyncSupervisor(ydoc, {
		url: config.url,
		waitFor: config.waitFor,
		openWebSocket: config.openWebSocket,
		log: config.log,
		onTextFrame() {},
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
		unsubscribeReconnectSignal();
	});

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
		/** Destroy the Y.Doc, cascading teardown to attached primitives. */
		[Symbol.dispose]() {
			ydoc.destroy();
		},
	};
}

export type Collaboration = ReturnType<typeof openCollaboration>;
