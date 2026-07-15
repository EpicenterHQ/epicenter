/// <reference lib="dom" />

/**
 * Internal sync supervisor: connects a Y.Doc to a WebSocket sync server and
 * runs the Yjs sync protocol (STEP1/STEP2/UPDATE).
 *
 * Lifecycle is supervisor-driven: connect, exponential backoff with jitter,
 * liveness via 60s pings and 90s timeout, browser online/offline/visibility
 * wakeups, permanent-failure park on 4401 close codes and on permanent local
 * auth denials (`OpenWebSocketDenial`), immediate reconnect on the server's
 * scheduled 4408 lifetime close. The supervisor emits a `SyncStatus` and
 * exposes `whenConnected`, `reconnect()`, and `whenDisposed`.
 */

import {
	encodeSyncStep1,
	encodeSyncUpdate,
	handleSyncPayload,
	isOpenWebSocketDenial,
	isTransportOrigin,
	MAIN_SUBPROTOCOL,
	SYNC_MESSAGE_TYPE,
	SYNC_ORIGIN,
	type SyncMessageType,
} from '@epicenter/sync';
import * as decoding from 'lib0/decoding';
import {
	defineErrors,
	extractErrorMessage,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import type * as Y from 'yjs';

// ════════════════════════════════════════════════════════════════════════════
// Public types (re-exported via open-collaboration)
// ════════════════════════════════════════════════════════════════════════════

export type SyncError = { type: 'connection' };

/**
 * Reason a sync entered the terminal `failed` phase.
 *
 * `code` is `string` (not a closed enum): the credential owner is the source
 * of truth for the vocabulary, so unknown codes pass through. Documented
 * codes today: server close reasons ('invalid_token', 'token_expired',
 * 'deauthorized', 'unknown') and local auth denials ('signed-out',
 * 'reauth-required') from a permanent `OpenWebSocketDenial`.
 */
export type SyncFailedReason = { type: 'auth'; code: string };

export type SyncStatus =
	| { phase: 'offline' }
	| { phase: 'connecting'; retries: number; lastError?: SyncError }
	| { phase: 'connected' }
	| { phase: 'failed'; reason: SyncFailedReason };

/**
 * Thrown via `whenConnected` rejection when the server signals a permanent
 * auth failure (close code 4401). The `code` carries the server's canonical
 * reason string so callers can switch on it without magic strings.
 */
const SyncFailedError = defineErrors({
	AuthRejected: ({ code }: { code: string }) => ({
		message: `[sync] server rejected auth: ${code}`,
		code,
	}),
});
type SyncFailedError = InferErrors<typeof SyncFailedError>;

/** Background lifecycle warnings logged by the supervisor. */
const SyncSupervisorError = defineErrors({
	WaitForRejected: ({ cause }: { cause: unknown }) => ({
		message: `[sync] waitFor rejected; starting sync anyway: ${extractErrorMessage(cause)}`,
		cause,
	}),
	CloseTimeout: ({ timeoutMs }: { timeoutMs: number }) => ({
		message: `[sync] WebSocket did not fire onclose within ${timeoutMs}ms; resolving whenDisposed anyway`,
		timeoutMs,
	}),
	PermanentClose: ({
		closeCode,
		reason,
	}: {
		closeCode: number;
		reason: SyncFailedReason;
	}) => ({
		message: `[sync] server sent permanent close ${closeCode}: ${reason.code}`,
		closeCode,
		reason,
	}),
	LocalAuthDenial: ({ code }: { code: string }) => ({
		message: `[sync] auth refused to open a socket: ${code}`,
		code,
	}),
});
type SyncSupervisorError = InferErrors<typeof SyncSupervisorError>;

/**
 * Function that opens a WebSocket to the relay. Matches the shape of
 * `AuthClient.openWebSocket`: the auth client's bearer-aware opener is the
 * canonical implementation, but any function with this shape works (tests
 * pass fakes, alternative deployments may use plain WebSockets).
 *
 * Declared here (the lowest sync layer) and re-exported upward via
 * `open-collaboration`, so there is one declaration rather than a copy per
 * layer. The re-export follows the existing `open-collaboration ->
 * sync-supervisor` edge, so it introduces no import cycle.
 */
export type OpenWebSocketFn = (
	url: string | URL,
	protocols?: string[],
) => Promise<WebSocket> | WebSocket;

type SyncSupervisorConfig = {
	url: string;
	waitFor?: Promise<unknown>;
	openWebSocket?: OpenWebSocketFn;
	log?: Logger;
	/**
	 * Receive WebSocket text frames. The supervisor never interprets text frames
	 * itself; downstream code receives the raw string.
	 */
	onTextFrame: (text: string) => void;
};

// ════════════════════════════════════════════════════════════════════════════
// Constants
// ════════════════════════════════════════════════════════════════════════════

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 30_000;
const PING_INTERVAL_MS = 60_000;
const LIVENESS_TIMEOUT_MS = 90_000;
const LIVENESS_CHECK_INTERVAL_MS = 10_000;
const CONNECT_TIMEOUT_MS = 15_000;
/**
 * App-defined WebSocket close code (4000-4999 range) signaling the server
 * permanently rejected this connection's auth. Distinguishes "give up" from
 * transient close codes (1006 network blip, 1011 server error, etc.).
 */
const PERMANENT_AUTH_CLOSE_CODE = 4401;
/**
 * App-defined close code the server sends when a connection exceeds its
 * bounded lifetime (the relay authenticates only at upgrade, so it closes
 * over-age sockets to force a fresh authenticated handshake). A scheduled
 * close, not a failure: the supervisor reconnects immediately instead of
 * sleeping through backoff.
 */
const CONNECTION_LIFETIME_CLOSE_CODE = 4408;
/**
 * Floor a session must have lasted for its 4408 close to count as scheduled.
 * The real lifetime bound is 30 minutes, so any legitimate lifetime close
 * clears this easily; a server that closes every handshake with 4408 right
 * away (a clock bug, a hostile relay) falls back to normal backoff instead
 * of inducing a zero-delay reconnect loop.
 */
const SCHEDULED_CLOSE_MIN_SESSION_MS = 1_000;

/**
 * Failsafe: returns null when `event` is not a permanent-failure signal,
 * `SyncFailedReason` otherwise. A buggy server that sends 4401 with malformed
 * JSON still produces a usable reason (`code: 'unknown'`); we never throw
 * from here.
 */
function parsePermanentFailure(event: {
	code: number;
	reason: string;
}): SyncFailedReason | null {
	if (event.code !== PERMANENT_AUTH_CLOSE_CODE) return null;
	try {
		const parsed = JSON.parse(event.reason) as unknown;
		if (
			parsed !== null &&
			typeof parsed === 'object' &&
			'code' in parsed &&
			typeof parsed.code === 'string'
		) {
			return { type: 'auth', code: parsed.code };
		}
	} catch {
		// fall through to 'unknown'
	}
	return { type: 'auth', code: 'unknown' };
}

// ════════════════════════════════════════════════════════════════════════════
// Public API
// ════════════════════════════════════════════════════════════════════════════

export function createSyncSupervisor(
	ydoc: Y.Doc,
	config: SyncSupervisorConfig,
) {
	const waitForPromise = config.waitFor;
	const log = config.log ?? createLogger('sync');

	const status = createStatusEmitter<SyncStatus>({ phase: 'offline' });
	function setStatus(next: SyncStatus) {
		const previous = status.get();
		status.set(next);
		if (previous.phase === next.phase) return;
		switch (next.phase) {
			case 'connected':
				log.info('sync connected', { phase: next.phase, docGuid: ydoc.guid });
				break;
			case 'failed':
				log.info('sync failed', {
					phase: next.phase,
					docGuid: ydoc.guid,
					reason: next.reason,
				});
				break;
			case 'offline':
				log.info('sync offline', { phase: next.phase, docGuid: ydoc.guid });
				break;
			case 'connecting':
				break;
			default:
				next satisfies never;
		}
	}

	// `whenConnected` settles once: resolved when the first successful handshake
	// lands (STEP2/UPDATE), rejected on permanent server auth failure (close
	// 4401) or on doc destroy before the first handshake.
	const connected = createOneShotPromise<void>();
	const backoff = createBackoff();

	/**
	 * Cancellation hierarchy:
	 *
	 *   masterController: aborts on doc.destroy(); kills everything
	 *      cycleController: aborts on reconnect();
	 *                       kills the current supervisor iteration
	 *
	 * `cycleController` is replaced (not just re-aborted) by `reconnect()` so
	 * the new connection cycle has a fresh signal unrelated to the old one.
	 * Aborting an already-aborted controller is a no-op, which makes repeated
	 * reconnects structurally safe. The supervisor reads `cycleController.signal`
	 * fresh at the top of each iteration; aborting the old one wakes a parked
	 * supervisor and the next iteration picks up the replacement.
	 */
	const masterController = new AbortController();
	let cycleController: AbortController = childOf(masterController.signal);

	let websocket: WebSocket | null = null;

	// Close code and open duration of the most recent socket close. Only
	// consulted right after `attemptConnection` returns 'connected', where
	// they are guaranteed fresh: a 'connected' result requires
	// `closePromise`, which resolves inside the same `onclose` that recorded
	// both values.
	let lastCloseCode = 0;
	let lastSessionMs = 0;

	function send(message: Uint8Array<ArrayBuffer> | string) {
		if (websocket?.readyState !== WebSocket.OPEN) return;
		if (typeof message === 'string') {
			websocket.send(message);
			return;
		}
		const copy = new Uint8Array(message.byteLength);
		copy.set(message);
		websocket.send(copy);
	}

	// ── Doc handlers ──

	function handleDocUpdate(update: Uint8Array, origin: unknown) {
		if (isTransportOrigin(origin)) return;
		send(encodeSyncUpdate({ update }));
	}

	// Browser online/offline/visibility wakeups. Auto-removed when the master
	// signal aborts. All three are no-ops when the supervisor isn't actively
	// trying to connect, so attaching at construction time before `waitFor`
	// settles is harmless.
	if (typeof window !== 'undefined') {
		window.addEventListener('online', () => backoff.wake(), {
			signal: masterController.signal,
		});
		window.addEventListener('offline', () => websocket?.close(), {
			signal: masterController.signal,
		});
	}
	if (typeof document !== 'undefined') {
		document.addEventListener(
			'visibilitychange',
			() => {
				if (document.visibilityState !== 'visible') return;
				if (websocket?.readyState === WebSocket.OPEN) websocket.send('ping');
			},
			{ signal: masterController.signal },
		);
	}

	async function attemptConnection(
		signal: AbortSignal,
	): Promise<'connected' | 'failed'> {
		let ws: WebSocket;
		try {
			const opened = (config.openWebSocket ?? openDefaultWebSocket)(
				config.url,
				[MAIN_SUBPROTOCOL],
			);
			ws = await opened;
		} catch (error) {
			// A permanent local denial (signed out, reauth required) takes the
			// same park path as a server 4401 close: only an auth state change
			// can produce a credential, and `onReconnectSignal` (auth state
			// changes) is the wake. Everything else, including transient
			// denials, is an ordinary failed attempt that backs off.
			if (isOpenWebSocketDenial(error) && error.permanence === 'permanent') {
				const reason: SyncFailedReason = { type: 'auth', code: error.code };
				setStatus({ phase: 'failed', reason });
				connected.reject(
					SyncFailedError.AuthRejected({ code: reason.code }).error,
				);
				log.warn(SyncSupervisorError.LocalAuthDenial({ code: reason.code }));
			}
			return 'failed';
		}
		if (signal.aborted) {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
			return 'failed';
		}
		ws.binaryType = 'arraybuffer';
		websocket = ws;

		const { promise: openPromise, resolve: resolveOpen } =
			Promise.withResolvers<boolean>();
		const { promise: closePromise, resolve: resolveClose } =
			Promise.withResolvers<void>();
		let handshakeComplete = false;

		const liveness = createLivenessMonitor(ws);

		const connectTimeout = setTimeout(() => {
			if (ws.readyState === WebSocket.CONNECTING) ws.close();
		}, CONNECT_TIMEOUT_MS);

		const onAbort = () => {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
		};
		const cleanupAbortListener = () => {
			signal.removeEventListener('abort', onAbort);
		};
		if (signal.aborted) {
			onAbort();
		} else {
			signal.addEventListener('abort', onAbort, { once: true });
		}

		let openedAt = 0;
		ws.onopen = () => {
			clearTimeout(connectTimeout);
			openedAt = performance.now();
			send(encodeSyncStep1({ doc: ydoc }));
			liveness.start();
			resolveOpen(true);
		};

		ws.onclose = (event: CloseEvent) => {
			clearTimeout(connectTimeout);
			cleanupAbortListener();
			liveness.stop();
			lastCloseCode = event.code;
			lastSessionMs = openedAt ? performance.now() - openedAt : 0;
			const failure = parsePermanentFailure(event);
			if (failure) {
				setStatus({ phase: 'failed', reason: failure });
				connected.reject(
					SyncFailedError.AuthRejected({ code: failure.code }).error,
				);
				log.warn(
					SyncSupervisorError.PermanentClose({
						closeCode: event.code,
						reason: failure,
					}),
				);
			}
			websocket = null;
			resolveOpen(false);
			resolveClose();
		};

		ws.onerror = () => {
			resolveOpen(false);
		};

		ws.onmessage = (event: MessageEvent) => {
			liveness.touch();
			if (typeof event.data === 'string') {
				config.onTextFrame(event.data);
				return;
			}

			// A binary frame is a sync frame: the first varint is the sync
			// sub-type, with no top-level message-type discriminator.
			const decoder = decoding.createDecoder(new Uint8Array(event.data));
			const syncType = decoding.readVarUint(decoder) as SyncMessageType;
			const payload = decoding.readVarUint8Array(decoder);
			const response = handleSyncPayload({
				syncType,
				payload,
				doc: ydoc,
				origin: SYNC_ORIGIN,
			});
			if (response) {
				send(response);
			} else if (
				!handshakeComplete &&
				(syncType === SYNC_MESSAGE_TYPE.STEP2 ||
					syncType === SYNC_MESSAGE_TYPE.UPDATE)
			) {
				handshakeComplete = true;
				setStatus({ phase: 'connected' });
				connected.resolve();
			}
		};

		const opened = await openPromise;
		if (!opened || signal.aborted) {
			if (
				ws.readyState !== WebSocket.CLOSED &&
				ws.readyState !== WebSocket.CLOSING
			) {
				ws.close();
			}
			await closePromise;
			return 'failed';
		}

		await closePromise;
		return handshakeComplete ? 'connected' : 'failed';
	}

	// Supervisor loop. Reads `cycleController.signal` fresh each iteration so
	// `reconnect()` swaps the controller and aborts the old; the supervisor
	// wakes from `attemptConnection`, `backoff.sleep`, or the parked-on-failed
	// `waitForAbort` and the next iteration picks up the replacement.
	const supervisorPromise = (async () => {
		if (waitForPromise) {
			const settled = Promise.resolve(waitForPromise).catch((cause) => {
				if (masterController.signal.aborted) return;
				log.warn(SyncSupervisorError.WaitForRejected({ cause }));
			});
			await Promise.race([settled, waitForAbort(masterController.signal)]);
		}
		if (masterController.signal.aborted) return;

		let lastError: SyncError | undefined;

		try {
			while (!masterController.signal.aborted) {
				// Park in `failed` until `reconnect` aborts the cycle to wake us.
				if (status.get().phase === 'failed') {
					await waitForAbort(cycleController.signal);
					continue;
				}

				const signal = cycleController.signal;

				setStatus({
					phase: 'connecting',
					retries: backoff.retries,
					lastError,
				});

				const result = await attemptConnection(signal);
				if (masterController.signal.aborted) break;

				if (result === 'connected') {
					backoff.reset();
					lastError = undefined;
				} else {
					lastError = { type: 'connection' };
				}

				// A lifetime close after a real session is the server's scheduled
				// re-handshake, not a failure: reconnect without the backoff sleep
				// to minimize the offline interval. The duration floor keeps
				// a misbehaving server from turning this into a zero-delay loop.
				const scheduledReconnect =
					result === 'connected' &&
					lastCloseCode === CONNECTION_LIFETIME_CLOSE_CODE &&
					lastSessionMs >= SCHEDULED_CLOSE_MIN_SESSION_MS;

				if (
					!scheduledReconnect &&
					!masterController.signal.aborted &&
					status.get().phase !== 'failed' &&
					!signal.aborted
				) {
					await backoff.sleep(signal);
				}
			}
		} finally {
			if (status.get().phase !== 'failed') setStatus({ phase: 'offline' });
			log.info('sync supervisor exited', {
				phase: status.get().phase,
				docGuid: ydoc.guid,
			});
		}
	})();

	function reconnect() {
		if (masterController.signal.aborted) return;
		if (status.get().phase === 'failed') setStatus({ phase: 'offline' });
		const old = cycleController;
		cycleController = childOf(masterController.signal);
		backoff.reset();
		old.abort();
	}

	ydoc.on('updateV2', handleDocUpdate);

	const { promise: whenDisposed, resolve: resolveDisposed } =
		Promise.withResolvers<void>();
	ydoc.once('destroy', async () => {
		try {
			masterController.abort();
			connected.reject(
				new Error('[sync] doc destroyed before first handshake'),
			);
			ydoc.off('updateV2', handleDocUpdate);
			const ws = websocket;
			status.clear();
			await supervisorPromise;
			await waitForWsClose(ws, 1000, log);
		} finally {
			resolveDisposed();
		}
	});

	return {
		/** Resolves after the first successful sync handshake. */
		whenConnected: connected.promise,
		/** Current sync lifecycle status. */
		get status() {
			return status.get();
		},
		/** Subscribe to sync status changes. Returns an unsubscribe function. */
		onStatusChange: status.subscribe,
		/** Restart the current connection cycle unless the document is disposed. */
		reconnect,
		/** Resolves after document destroy tears down the supervisor. */
		whenDisposed,
		/**
		 * Send a frame on the active connection. Silently drops if the socket is
		 * not currently OPEN, matching awareness updates that may fire offline.
		 */
		send,
	};
}

export type SyncSupervisor = ReturnType<typeof createSyncSupervisor>;

// ════════════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════════════

function openDefaultWebSocket(
	url: string | URL,
	protocols?: string[],
): WebSocket {
	return new WebSocket(url, protocols);
}

/**
 * One-shot promise with idempotent `resolve`/`reject`. Pre-attaches a no-op
 * `.catch` so a rejection without a consumer does not surface as an
 * unhandled rejection.
 */
function createOneShotPromise<T>() {
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	promise.catch(() => {});
	let settled = false;
	return {
		promise,
		resolve(value: T) {
			if (settled) return;
			settled = true;
			resolve(value);
		},
		reject(error: unknown) {
			if (settled) return;
			settled = true;
			reject(error);
		},
	};
}

/** Resolves when the signal aborts (or immediately if already aborted). */
function waitForAbort(signal: AbortSignal): Promise<void> {
	if (signal.aborted) return Promise.resolve();
	return new Promise<void>((resolve) => {
		signal.addEventListener('abort', () => resolve(), { once: true });
	});
}

function createStatusEmitter<T>(initial: T) {
	let current = initial;
	const listeners = new Set<(value: T) => void>();
	return {
		get() {
			return current;
		},
		set(value: T) {
			current = value;
			for (const listener of listeners) listener(value);
		},
		subscribe(listener: (value: T) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},
		clear() {
			listeners.clear();
		},
	};
}

function createLivenessMonitor(ws: WebSocket) {
	let pingInterval: ReturnType<typeof setInterval> | null = null;
	let livenessInterval: ReturnType<typeof setInterval> | null = null;
	let lastMessageTime = 0;

	function stop() {
		if (pingInterval) clearInterval(pingInterval);
		if (livenessInterval) clearInterval(livenessInterval);
	}

	return {
		start() {
			stop();
			lastMessageTime = Date.now();

			pingInterval = setInterval(() => {
				if (ws.readyState === WebSocket.OPEN) ws.send('ping');
			}, PING_INTERVAL_MS);

			livenessInterval = setInterval(() => {
				if (Date.now() - lastMessageTime > LIVENESS_TIMEOUT_MS) {
					ws.close();
				}
			}, LIVENESS_CHECK_INTERVAL_MS);
		},
		touch() {
			lastMessageTime = Date.now();
		},
		stop,
	};
}

/**
 * Await a WebSocket's `close` event, with a timeout safeguard.
 *
 * Resolves immediately if the socket is null or already CLOSED. A
 * misbehaving server that never sends a close frame should not block
 * teardown indefinitely.
 */
function waitForWsClose(
	ws: WebSocket | null,
	timeoutMs: number,
	log: Logger,
): Promise<void> {
	if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
	return new Promise<void>((resolve) => {
		const onClose = () => {
			clearTimeout(timer);
			resolve();
		};
		ws.addEventListener('close', onClose, { once: true });
		const timer = setTimeout(() => {
			ws.removeEventListener('close', onClose);
			log.warn(SyncSupervisorError.CloseTimeout({ timeoutMs }));
			resolve();
		}, timeoutMs);
	});
}

function createBackoff() {
	let retries = 0;
	let externalWake: (() => void) | null = null;

	return {
		/**
		 * Sleep for exponentially-jittered backoff. Returns early on `signal`
		 * abort or on an explicit `wake()` (e.g. window 'online' event). Never
		 * throws. Callers re-check `signal.aborted` after.
		 */
		async sleep(signal: AbortSignal): Promise<void> {
			const exponential = Math.min(BASE_DELAY_MS * 2 ** retries, MAX_DELAY_MS);
			const ms = exponential * (0.5 + Math.random() * 0.5);
			retries += 1;

			if (signal.aborted) return;

			return new Promise<void>((resolve) => {
				const cleanup = () => {
					clearTimeout(handle);
					signal.removeEventListener('abort', onAbort);
					externalWake = null;
				};
				const handle = setTimeout(() => {
					cleanup();
					resolve();
				}, ms);
				const onAbort = () => {
					cleanup();
					resolve();
				};
				signal.addEventListener('abort', onAbort, { once: true });
				externalWake = () => {
					cleanup();
					resolve();
				};
			});
		},
		/** External wake (e.g. window 'online' event): short-circuits the sleep without aborting the cycle. */
		wake() {
			externalWake?.();
		},
		reset() {
			retries = 0;
		},
		get retries() {
			return retries;
		},
	};
}

/**
 * Build an `AbortController` whose signal is aborted whenever `parent` is.
 * Aborting the child does NOT abort the parent. The parent->child listener
 * self-cleans when the child is aborted first via the `signal` option.
 */
function childOf(parent: AbortSignal): AbortController {
	const child = new AbortController();
	if (parent.aborted) {
		child.abort(parent.reason);
	} else {
		parent.addEventListener('abort', () => child.abort(parent.reason), {
			once: true,
			signal: child.signal,
		});
	}
	return child;
}
