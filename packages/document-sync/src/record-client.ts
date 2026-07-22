import {
	type RecordAddress,
	type RowDocument,
	recordDocumentConnectionTarget,
	type SyncCredentialProvider,
} from '@epicenter/data/record';
import { BEARER_SUBPROTOCOL_PREFIX } from '@epicenter/sync';
import {
	DOCUMENT_BACKSTOP_CLOSE_CODE,
	DOCUMENT_SUBPROTOCOL,
	decodeDocumentFrame,
	encodeDocumentFrame,
	exceedsDocumentBound,
	measureDocumentState,
} from '@epicenter/sync/document-v3';

const SOCKET_OPEN = 1;
const SOCKET_CLOSED = 3;
const BASE_RETRY_MS = 500;
const MAX_RETRY_MS = 30_000;
const remoteOrigin = Symbol('epicenter-record-document-sync-remote');

export type RecordDocumentClientSocket = {
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

type OpenedRecordDocumentSocket = RecordDocumentClientSocket | WebSocket;

export type RecordDocumentSocketOpener = (
	url: URL,
	protocols: string[],
) => OpenedRecordDocumentSocket | Promise<OpenedRecordDocumentSocket>;

export type RecordAuthorityLifetimeProvider = {
	get(): string | undefined;
	subscribe(listener: () => void): () => void;
};

export type RecordDocumentConnectionStatus =
	| 'connecting'
	| 'connected'
	| 'offline'
	| 'authentication-required'
	| 'refused'
	| 'revoked'
	| 'disposed';

export type ConnectRecordDocumentOptions = {
	document: RowDocument;
	baseUrl: string | URL;
	authorityLifetime: RecordAuthorityLifetimeProvider;
	schedule?: (task: () => void, delayMs: number) => () => void;
} & (
	| {
			/** Auth-owned opener that attaches its own credentials. */
			openSocket: RecordDocumentSocketOpener;
			/** Optional availability signal; its value is never sent by this connector. */
			credentials?: SyncCredentialProvider;
	  }
	| {
			/** Raw bearer used only by the default direct WebSocket opener. */
			credentials: SyncCredentialProvider;
			openSocket?: undefined;
	  }
);

/** Build the record-scoped realtime overlay URL without putting credentials in it. */
export function recordDocumentWebSocketUrl({
	baseUrl,
	address,
	authorityLifetime,
}: {
	baseUrl: string | URL;
	address: RecordAddress;
	authorityLifetime: string;
}): URL {
	if (authorityLifetime.length === 0) {
		throw new TypeError('Authority lifetime is required');
	}
	const url = new URL(baseUrl);
	if (url.protocol === 'https:') url.protocol = 'wss:';
	else if (url.protocol === 'http:') url.protocol = 'ws:';
	else throw new TypeError('Document base URL must use HTTP or HTTPS');
	url.pathname = `/api/sync/v1/records/${encodeURIComponent(address.namespace)}/${encodeURIComponent(address.collection)}/${encodeURIComponent(address.recordKey)}/document`;
	url.search = '';
	url.searchParams.set('authorityLifetime', authorityLifetime);
	url.hash = '';
	return url;
}

/** Connect one open record document to the presence-free Document V3 overlay. */
export function connectRecordDocument({
	document,
	baseUrl,
	authorityLifetime,
	credentials,
	openSocket,
	schedule = scheduleTimeout,
}: ConnectRecordDocumentOptions) {
	const target = recordDocumentConnectionTarget(document);
	const socketOpener = openSocket ?? openBrowserSocket;
	const isAuthOwnedSocket = openSocket !== undefined;
	const listeners = new Set<(status: RecordDocumentConnectionStatus) => void>();
	const firstConnection = Promise.withResolvers<void>();
	void firstConnection.promise.catch(() => undefined);
	let status: RecordDocumentConnectionStatus = 'connecting';
	let socket: OpenedRecordDocumentSocket | undefined;
	let cancelRetry: (() => void) | undefined;
	let retryAttempt = 0;
	let cycle = 0;
	let isDisposed = false;
	let connectedOnce = false;
	let handshakeComplete = false;
	let serverStateVector: Uint8Array | undefined;
	let observedAuthorityLifetime = authorityLifetime.get();

	function setStatus(next: RecordDocumentConnectionStatus): void {
		if (status === next) return;
		status = next;
		for (const listener of listeners) {
			try {
				listener(next);
			} catch {
				// An observer cannot interrupt connection ownership.
			}
		}
	}

	function send(frame: Parameters<typeof encodeDocumentFrame>[0]): void {
		if (socket?.readyState !== SOCKET_OPEN) return;
		socket.send(encodeDocumentFrame(frame));
	}

	function isOverBound(): boolean {
		return exceedsDocumentBound(
			measureDocumentState(target.encodeStateAsUpdate()),
		);
	}

	function sendStateReply(): void {
		if (
			!handshakeComplete ||
			serverStateVector === undefined ||
			isOverBound()
		) {
			return;
		}
		send({
			kind: 'sync-response',
			update: target.encodeStateAsUpdate(serverStateVector),
		});
	}

	function handleUpdate(update: Uint8Array, origin: unknown): void {
		if (origin === remoteOrigin || !handshakeComplete || isOverBound()) return;
		send({ kind: 'update', update });
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

	function finish(next: 'disposed' | 'refused' | 'revoked'): void {
		if (isDisposed) return;
		isDisposed = true;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		stopUpdates();
		stopCredentials?.();
		stopAuthorityLifetime();
		stopRevocation();
		closeCurrent();
		setStatus(next);
		if (!connectedOnce) {
			firstConnection.reject(new Error(`Document connection ${next}`));
		}
	}

	function retry(): void {
		if (isDisposed) return;
		if (observedAuthorityLifetime === undefined) {
			setStatus('offline');
			return;
		}
		if (credentials?.get() === undefined && credentials !== undefined) {
			setStatus('authentication-required');
			return;
		}
		setStatus('offline');
		const delay = Math.min(BASE_RETRY_MS * 2 ** retryAttempt, MAX_RETRY_MS);
		retryAttempt += 1;
		cancelRetry?.();
		cancelRetry = schedule(() => {
			cancelRetry = undefined;
			void connect();
		}, delay);
	}

	function bind(opened: OpenedRecordDocumentSocket, activeCycle: number): void {
		if (isDisposed || activeCycle !== cycle) {
			opened.close();
			return;
		}
		socket = opened;
		opened.binaryType = 'arraybuffer';
		handshakeComplete = false;
		serverStateVector = undefined;
		const onOpen = () => {
			if (opened.protocol !== DOCUMENT_SUBPROTOCOL) {
				opened.close(1002, 'invalid-document-subprotocol');
				return;
			}
			send({ kind: 'sync-request', stateVector: target.encodeStateVector() });
		};
		opened.onopen = onOpen;
		opened.onmessage = (event: { data: unknown }) => {
			if (socket !== opened || isDisposed) return;
			try {
				const frame = decodeDocumentFrame(messageBytes(event.data));
				switch (frame.kind) {
					case 'sync-request':
						serverStateVector = frame.stateVector;
						if (handshakeComplete) sendStateReply();
						return;
					case 'sync-response':
						target.applyUpdate(frame.update, remoteOrigin);
						if (handshakeComplete) return;
						handshakeComplete = true;
						sendStateReply();
						retryAttempt = 0;
						setStatus('connected');
						if (!connectedOnce) {
							connectedOnce = true;
							firstConnection.resolve();
						}
						return;
					case 'update':
						target.applyUpdate(frame.update, remoteOrigin);
						return;
				}
			} catch {
				opened.close(1002, 'invalid-document-frame');
			}
		};
		opened.onerror = () => undefined;
		opened.onclose = ({ code, reason }: { code: number; reason: string }) => {
			if (socket !== opened) return;
			socket = undefined;
			if (isDisposed || activeCycle !== cycle) return;
			if (
				code === DOCUMENT_BACKSTOP_CLOSE_CODE ||
				reason === 'document-bound' ||
				reason === 'invalid-document-subprotocol' ||
				reason === 'invalid-document-frame'
			) {
				finish('refused');
				return;
			}
			if (reason === 'record-not-live' || reason === 'lifetime-mismatch') {
				finish('revoked');
				return;
			}
			retry();
		};
		if (opened.readyState === SOCKET_OPEN) onOpen();
	}

	async function connect(): Promise<void> {
		if (isDisposed) return;
		const activeAuthorityLifetime = observedAuthorityLifetime;
		if (activeAuthorityLifetime === undefined) {
			setStatus('offline');
			return;
		}
		const credential = credentials?.get();
		if (credentials !== undefined && credential === undefined) {
			setStatus('authentication-required');
			return;
		}
		if (
			!isAuthOwnedSocket &&
			(credential === undefined ||
				credential.length === 0 ||
				/[\s,]/u.test(credential))
		) {
			setStatus('authentication-required');
			return;
		}
		const activeCycle = ++cycle;
		setStatus('connecting');
		try {
			const opened = await socketOpener(
				recordDocumentWebSocketUrl({
					baseUrl,
					address: target.address,
					authorityLifetime: activeAuthorityLifetime,
				}),
				isAuthOwnedSocket
					? [DOCUMENT_SUBPROTOCOL]
					: [DOCUMENT_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${credential}`],
			);
			bind(opened, activeCycle);
		} catch {
			if (!isDisposed && activeCycle === cycle) retry();
		}
	}

	function credentialsChanged(): void {
		if (isDisposed) return;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		closeCurrent();
		void connect();
	}

	function authorityLifetimeChanged(): void {
		if (isDisposed) return;
		const nextAuthorityLifetime = authorityLifetime.get();
		if (nextAuthorityLifetime === observedAuthorityLifetime) return;
		observedAuthorityLifetime = nextAuthorityLifetime;
		cycle += 1;
		cancelRetry?.();
		cancelRetry = undefined;
		closeCurrent();
		void connect();
	}

	const stopUpdates = target.observe(handleUpdate);
	const stopCredentials = credentials?.subscribe?.(credentialsChanged);
	const stopAuthorityLifetime = authorityLifetime.subscribe(
		authorityLifetimeChanged,
	);
	const stopRevocation = target.subscribeRevocation(() => finish('revoked'));
	void connect();

	return {
		whenConnected: firstConnection.promise,
		get status(): RecordDocumentConnectionStatus {
			return status;
		},
		subscribeStatus(listener: (next: RecordDocumentConnectionStatus) => void) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		dispose: () => finish('disposed'),
	};
}

function openBrowserSocket(
	url: URL,
	protocols: string[],
): RecordDocumentClientSocket {
	return new WebSocket(url, protocols) as RecordDocumentClientSocket;
}

function messageBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	}
	throw new TypeError('Document frames are binary');
}

function scheduleTimeout(task: () => void, delayMs: number): () => void {
	const timer = setTimeout(task, delayMs);
	return () => clearTimeout(timer);
}
