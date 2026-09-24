/**
 * The client half of a store dial: what a socket is opened with, and who opens
 * it.
 *
 * A browser upgrade cannot set `Authorization`, so a dial is a URL and a
 * subprotocol list, and the two are one value here. The route builds the
 * address, auth appends the bearer entry, and a consumer imports this type
 * rather than declaring a narrower one (ADR-0346).
 */

/**
 * Everything a dial needs except the credential.
 *
 * `STORE_SYNC_ROUTE.address` builds it, an `openWebSocket` implementation
 * appends `bearerSubprotocol(token)` to `protocols`, and the server reads the
 * main subprotocol and the bearer back out of the one header.
 *
 * `protocols` is non-empty by TYPE, because an upgrade offering no protocols is
 * refused with a 400 the page cannot see. The list is what let a dial go wrong
 * silently once already: a lossy one-parameter port dropped it, nothing
 * complained, and the app looked signed in while syncing nothing. Bundling it
 * with the URL is what closed that; requiring a first entry is what stops the
 * empty list from reopening it.
 */
export type WebSocketAddress = {
	url: string;
	protocols: readonly [string, ...string[]];
};

/** How a host reaches its authority over a socket. */
export type SocketTransport = {
	/**
	 * Open a credentialed socket, or reject.
	 *
	 * Waits for in-flight machine work such as a token refresh, never for a
	 * human, so a rejection means signed out rather than slow. A rejection
	 * recognised by {@link isOpenWebSocketDenial} is reported as that refusal's
	 * code and dialled again on the ordinary backoff; anything else is a
	 * transport error and a close.
	 */
	openWebSocket(address: WebSocketAddress): Promise<WebSocket>;
};

/**
 * Why a credential model refused to open a socket.
 *
 * A closed union so a status surface can map every arm exhaustively.
 */
export type SyncRefusal =
	/** No credential is held on this device. */
	| 'signed-out'
	/** The server refused the credential; only a sign-in produces a new one. */
	| 'reauth-required'
	/** The credential could not be verified right now; the next try may succeed. */
	| 'auth-unavailable'
	/** This client can never open a socket: a same-origin cookie, a desktop window. */
	| 'no-credential-model';

/**
 * Rejection an auth-owned `openWebSocket` throws when it refuses to open a
 * socket because no usable bearer can be attached right now.
 *
 * `code` says which refusal it is, and that is the whole of it. A refusal is
 * not a stop signal: the sync driver reports it as data on its status and
 * dials again on its ordinary backoff. Every arm but `'auth-unavailable'` is
 * decided locally with no request on the wire, so a dial capped at thirty
 * seconds costs a status read and nothing else.
 *
 * Declared here, beside {@link SocketTransport}, because it is the other half
 * of the same client-side transport contract: `@epicenter/auth` constructs it
 * and the sync supervisor classifies it, and both already depend on this
 * package.
 */
export type OpenWebSocketDenial = {
	name: 'OpenWebSocketDenied';
	message: string;
	code: SyncRefusal;
};

const SYNC_REFUSALS: readonly SyncRefusal[] = [
	'signed-out',
	'reauth-required',
	'auth-unavailable',
	'no-credential-model',
];

/** Classify an unknown rejection as an {@link OpenWebSocketDenial}. */
export function isOpenWebSocketDenial(
	value: unknown,
): value is OpenWebSocketDenial {
	if (typeof value !== 'object' || value === null) return false;
	const candidate = value as Partial<OpenWebSocketDenial>;
	return (
		candidate.name === 'OpenWebSocketDenied' &&
		SYNC_REFUSALS.includes(candidate.code as SyncRefusal)
	);
}
