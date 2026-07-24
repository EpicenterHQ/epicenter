import {
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/sync/document-v3';

import { decodeDocumentAcceptance } from '../document-v1/index.js';
import {
	type RecordAddress,
	SCALAR_SYNC_V1_LIMITS,
} from '../protocol/v1/index.js';

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;

/**
 * The transport surface one realtime document channel drives. The carrier
 * owns URL construction and authentication; the runtime owns everything the
 * socket carries.
 */
export type DocumentRealtimeSocket = {
	readonly readyState: number;
	readonly protocol: string;
	binaryType: string;
	onopen: (() => void) | null;
	onmessage: ((event: { data: unknown }) => void) | null;
	onerror: (() => void) | null;
	onclose:
		| ((event: { code: number; reason: string; wasClean: boolean }) => void)
		| null;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
};

/**
 * The optional realtime seam on an authority carrier. Opening obtains a
 * fresh credential every time, so reconnection never mutates a live token.
 */
export type DocumentRealtimeOpener = {
	open(
		address: RecordAddress,
		authorityLifetime: string,
	): Promise<DocumentRealtimeSocket>;
};

/**
 * One live document as the channel sees it. `installAccepted` persists an
 * authority-accepted remote update durably before it becomes live, and
 * `observeLocal` delivers only locally authored updates that are already
 * durable, so the channel can never replay remote bytes as local work.
 */
export type DocumentRealtimeTarget = {
	stateVector(): Uint8Array;
	encodeStateAsUpdate(stateVector?: Uint8Array): Uint8Array;
	installAccepted(update: Uint8Array): Promise<void>;
	observeLocal(listener: (update: Uint8Array) => void): () => void;
};

export type DocumentRealtimeSchedule = (
	task: () => void,
	delayMs: number,
) => () => void;

export type ConnectDocumentRealtimeOptions = {
	address: RecordAddress;
	target: DocumentRealtimeTarget;
	opener: DocumentRealtimeOpener;
	/**
	 * The replica's currently bound authority lifetime, or `null` before the
	 * first facts install. A channel cannot connect without one; it retries
	 * with backoff until binding happens.
	 */
	authorityLifetime(): Promise<string | null>;
	/**
	 * The authority refused the record as not live. The channel has already
	 * stopped permanently; the runtime should drain facts so the terminal
	 * scalar state arrives and revokes open handles.
	 */
	onRecordNotLive?(): void;
	/** The authority lifetime changed. The scalar planes own replacement. */
	onLifetimeMismatch?(): void;
	schedule?: DocumentRealtimeSchedule;
};

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}

function messageBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new TypeError('Document frames are binary');
}

/**
 * Own one realtime overlay for one open record document.
 *
 * The channel is convergence only: inbound accepted updates install durably
 * and become live, and outbound local updates enter the same authority
 * acceptance the HTTP publication path uses. Acceptance frames are consumed
 * as convergence acknowledgements and never advance the accepted-revision
 * watermark; the runtime supervisor's complete-state publication remains the
 * one durable settlement path.
 */
export function connectDocumentRealtime({
	address,
	target,
	opener,
	authorityLifetime,
	onRecordNotLive,
	onLifetimeMismatch,
	schedule = scheduleTimeout,
}: ConnectDocumentRealtimeOptions) {
	let socket: DocumentRealtimeSocket | undefined;
	let cancelRetry: (() => void) | undefined;
	let retryAttempt = 0;
	let cycle = 0;
	let isStopped = false;
	let handshakeComplete = false;
	let serverStateVector: Uint8Array | undefined;
	// Frames install in arrival order; a failed install stops the channel
	// instead of applying later remote bytes over an unknown durable state.
	let installTail: Promise<void> = Promise.resolve();

	function send(frame: Parameters<typeof encodeDocumentFrame>[0]): void {
		if (socket?.readyState !== SOCKET_OPEN) return;
		socket.send(new Uint8Array(encodeDocumentFrame(frame)));
	}

	function isOverBound(): boolean {
		return exceedsDocumentBound(
			measureDocumentState(target.encodeStateAsUpdate()),
		);
	}

	function sendStateReply(): void {
		if (!handshakeComplete || serverStateVector === undefined || isOverBound())
			return;
		send({
			kind: 'sync-response',
			update: target.encodeStateAsUpdate(serverStateVector),
		});
	}

	function closeCurrent(): void {
		const opened = socket;
		socket = undefined;
		if (opened === undefined) return;
		opened.onopen = null;
		opened.onmessage = null;
		opened.onerror = null;
		opened.onclose = null;
		if (opened.readyState !== SOCKET_CLOSED) opened.close();
	}

	function stop(): void {
		if (isStopped) return;
		isStopped = true;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		stopLocalUpdates();
		closeCurrent();
	}

	function retry(): void {
		if (isStopped) return;
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		cancelRetry?.();
		cancelRetry = schedule(() => {
			cancelRetry = undefined;
			void connect();
		}, delay);
	}

	function installRemote(update: Uint8Array, activeCycle: number): void {
		installTail = installTail.then(async () => {
			if (isStopped || activeCycle !== cycle) return;
			try {
				await target.installAccepted(update);
			} catch {
				// The local record refused the install (typically terminal or
				// unset). Scalar facts own revocation; stop instead of looping.
				stop();
				onRecordNotLive?.();
			}
		});
	}

	function bind(opened: DocumentRealtimeSocket, activeCycle: number): void {
		if (isStopped || activeCycle !== cycle) {
			opened.close();
			return;
		}
		socket = opened;
		opened.binaryType = 'arraybuffer';
		handshakeComplete = false;
		serverStateVector = undefined;
		const onOpen = () => {
			if (opened.protocol !== DOCUMENT_SUBPROTOCOL) {
				opened.close();
				return;
			}
			send({ kind: 'sync-request', stateVector: target.stateVector() });
		};
		opened.onopen = onOpen;
		opened.onmessage = (event) => {
			if (socket !== opened || isStopped) return;
			try {
				const frame = decodeDocumentFrame(messageBytes(event.data));
				switch (frame.kind) {
					case 'sync-request':
						serverStateVector = frame.stateVector;
						if (handshakeComplete) sendStateReply();
						return;
					case 'sync-response':
						installRemote(frame.update, activeCycle);
						if (handshakeComplete) return;
						handshakeComplete = true;
						sendStateReply();
						retryAttempt = 0;
						return;
					case 'update':
						installRemote(frame.update, activeCycle);
						return;
					case 'publication-response': {
						const acceptance = decodeDocumentAcceptance(
							frame.acceptance,
							SCALAR_SYNC_V1_LIMITS,
						);
						if (acceptance === undefined) {
							throw new TypeError('invalid document acceptance');
						}
						// Convergence acknowledgement only. Refusals arrive with a
						// server-initiated close that the close handler classifies.
						return;
					}
				}
			} catch {
				opened.close();
			}
		};
		opened.onerror = () => undefined;
		opened.onclose = (event) => {
			if (socket !== opened) return;
			socket = undefined;
			if (isStopped || activeCycle !== cycle) return;
			if (event.reason === 'record-not-live') {
				stop();
				onRecordNotLive?.();
				return;
			}
			if (event.reason === 'lifetime-mismatch') {
				stop();
				onLifetimeMismatch?.();
				return;
			}
			retry();
		};
		if (opened.readyState === SOCKET_OPEN) onOpen();
	}

	async function connect(): Promise<void> {
		if (isStopped) return;
		const activeCycle = ++cycle;
		try {
			const lifetime = await authorityLifetime();
			if (isStopped || activeCycle !== cycle) return;
			if (lifetime === null) {
				retry();
				return;
			}
			const opened = await opener.open(address, lifetime);
			bind(opened, activeCycle);
		} catch {
			if (!isStopped && activeCycle === cycle) retry();
		}
	}

	const stopLocalUpdates = target.observeLocal((update) => {
		if (!handshakeComplete || isOverBound()) return;
		send({ kind: 'update', update });
	});
	void connect();

	return {
		/** Permanently stop the channel and release the socket and observers. */
		dispose(): void {
			stop();
		},
	};
}

export type DocumentRealtimeChannel = ReturnType<
	typeof connectDocumentRealtime
>;
