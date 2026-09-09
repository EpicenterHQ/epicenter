/**
 * One principal's authority for one generation of one database, in a Durable
 * Object.
 *
 * A thin adapter and nothing more. Every rule about who has been sent what
 * lives in `@epicenter/data/sync`, so what is deployed here and what the
 * transport's tests drive are the same object rather than two that agree today.
 *
 * The authority reads nothing (ADR-0298, restoring ADR-0218). It holds opaque
 * bytes, hands them back in order, and folds acknowledged log prefixes.
 * Nothing here imports Yjs or a store, and there is no verb that could.
 *
 * The generation is in the object's NAME (ADR-0292), so this object holds one
 * history and cannot be pointed at another. That is what deleted the document
 * announcement, the bootstrap round-trip, and the retirement close. Each
 * authenticated upgrade gets at most 600 seconds of socket access. The
 * authority checks that deadline before receiving, sending, or catching up.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	createSyncHub,
	type HubConnection,
	openSyncAuthority,
	type SyncAuthority,
	type SyncHub,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { LOG_POSITION_HEADER } from '@epicenter/sync/generations-route';

/**
 * A socket's position and fixed authorization deadline survive hibernation.
 *
 * The in-memory map is the fast path and the attachment is the fallback. They
 * can disagree only in the safe direction: a woken object reads a position that
 * is BEHIND, re-sends entries the replica already has, and every one of them is
 * idempotent. The other direction would skip, and a skipped entry is invisible
 * forever.
 */
function attachmentOf(socket: WebSocket) {
	return socket.deserializeAttachment() as {
		cursor: number;
		authorizedUntil: number;
	} | null;
}

export class StoreAuthority extends DurableObject {
	private readonly authority: SyncAuthority;
	private readonly hub: SyncHub;
	/** One connection object per live socket, so the hub sees stable identities. */
	private readonly connections = new Map<WebSocket, HubConnection>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		const sqlite = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.authority = openSyncAuthority({ sqlite });
		this.hub = createSyncHub({ authority: this.authority });
		// A woken object has sockets and nothing else: no map, and a hub that has
		// never heard of them. Both are rebuilt here, before any message can
		// arrive, from the attachments the sockets carry.
		for (const socket of ctx.getWebSockets()) this.adopt(socket);
	}

	/**
	 * Wrap one socket as a connection, attach it to the hub, and keep its
	 * position durable.
	 *
	 * Joining is not separable from wrapping, and a wake is what proves it. The
	 * hub drops a message from a connection it has not joined, silently and by
	 * design, so an object that rebuilt only `connections` was deaf and mute: it
	 * took every push, stored none, never acknowledged and never refused, and
	 * relayed nothing. A replica cannot tell that apart from a quiet network, so
	 * it holds the work forever believing it is in transit.
	 *
	 * Joining also runs catch-up, which on a wake is the whole recovery.
	 */
	private adopt(socket: WebSocket): HubConnection | undefined {
		if (!this.isAuthorized(socket)) return undefined;
		const existing = this.connections.get(socket);
		if (existing !== undefined) return existing;
		const attached = attachmentOf(socket)!;
		let written = attached.cursor;
		const connection: HubConnection = {
			cursor: written,
			send: (bytes) => {
				// A closing or closed socket takes nothing more: the hub's send is
				// fire-and-forget, and workerd throws on a dead socket.
				if (!this.isAuthorized(socket)) return;
				socket.send(bytes);
				// `serializeAttachment` is a DURABLE STORAGE WRITE. Written after the
				// send rather than before, so a failure leaves the position behind
				// rather than ahead, and only when it actually moved: a chunked entry
				// relayed to several sockets would otherwise be several writes of a
				// value that had not changed.
				if (connection.cursor === written) return;
				written = connection.cursor;
				socket.serializeAttachment({ ...attached, cursor: written });
			},
		};
		if (this.hub.join(connection) !== 'admitted') {
			// Storage that cannot be read: fail closed, with no membership and no
			// cache entry, so a frame arriving after this close re-runs admission
			// and meets the same verdict.
			socket.close(1000, 'authority unavailable');
			return undefined;
		}
		this.connections.set(socket, connection);
		// Catch-up may have closed the socket while the hub was joining it.
		if (!this.isAuthorized(socket)) {
			this.forget(socket);
			return undefined;
		}
		return connection;
	}

	/**
	 * Take one authenticated store-sync upgrade, or one bulk transfer.
	 *
	 * Three verbs over one object, and they never overlap (ADR-0292): the
	 * socket carries what is being edited, `POST` brings this generation into
	 * being from one whole state, and `GET` hands that state to a device that
	 * does not have it. The last two are HTTP because getting a complete copy
	 * is parallel, resumable, cacheable, and needs no protocol.
	 */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			if (request.method === 'POST') return this.seed(request);
			if (request.method === 'GET') return this.serve();
			return new Response('The store transport is WebSocket-only', {
				status: 426,
			});
		}
		const query = new URL(request.url).searchParams;
		const asked = Number(query.get('cursor') ?? '0');
		const cursor = Number.isFinite(asked) && asked >= 0 ? asked : 0;
		const pair = new WebSocketPair();

		this.ctx.acceptWebSocket(pair[1]);
		// Written before adopting, because the attachment is where a position
		// comes from: this is the one place it is set from a request rather than
		// read back off the socket, and there is no second source of truth.
		// Only the authority's clock grants this lifetime. Request headers and
		// query parameters cannot extend it, including for static-token peers.
		pair[1].serializeAttachment({
			cursor,
			authorizedUntil: Date.now() + 600_000,
		});
		await this.scheduleAuthorizationAlarm();
		// Catch-up runs here, synchronously, before this handler returns, so the
		// replica's contiguity check holds by construction. The upgrade itself
		// succeeds either way, because a browser can read a frame and cannot
		// read a refused handshake.
		this.adopt(pair[1]);

		return new Response(null, { status: 101, webSocket: pair[0] });
	}

	/**
	 * Store one whole database state as this generation's first snapshot.
	 *
	 * Refused on a log that already holds anything: a generation is created
	 * once and never mutated in place, so a second seed is a caller confusing
	 * import with sync. The refusal is `409`, and a client that meets one
	 * lists generations rather than retrying (ADR-0293).
	 */
	private async seed(request: Request): Promise<Response> {
		const body = new Uint8Array(await request.arrayBuffer());
		if (body.length === 0) {
			return new Response('a generation needs a state', { status: 400 });
		}
		const { data: position, error } = this.authority.seed(body);
		if (error !== null) {
			return new Response(error.message, {
				status: error.name === 'SnapshotRefused' ? 409 : 500,
			});
		}
		return Response.json({ position });
	}

	/**
	 * This generation's whole state, and the position it is current through.
	 *
	 * Served verbatim from the snapshot the import wrote, because the state is
	 * stored whole and the authority has no way to re-encode it. The position
	 * rides in a header so a bootstrapping device seeds its cursor there and
	 * the socket carries only what happened afterwards, rather than being
	 * handed the same state a second time.
	 */
	private serve(): Response {
		const { data: snapshot, error } = this.authority.snapshot();
		if (error !== null) return new Response(error.message, { status: 500 });
		if (snapshot === undefined) {
			return new Response('this generation has no stored state', {
				status: 404,
			});
		}
		return new Response(snapshot.bytes as unknown as BodyInit, {
			headers: {
				'content-type': 'application/octet-stream',
				[LOG_POSITION_HEADER]: String(snapshot.position),
			},
		});
	}

	override webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): void {
		if (!this.isAuthorized(socket)) return;
		if (typeof message === 'string') return;
		// Nothing thrown. `workerd` swallows a throw here WITHOUT closing the
		// socket, so a replica would wait forever on a submission that had already
		// failed; a refusal has to travel as a frame, and the hub sends one.
		//
		// `adopt` restores hub membership for an authorized socket after wake.
		// Generation isolation currently comes from this object's address;
		// adoption does not check whether that generation has been retired.
		const connection = this.adopt(socket);
		if (connection === undefined) return;
		this.hub.receive(connection, new Uint8Array(message));
	}

	/**
	 * The peer went away, so complete the handshake and let it go.
	 *
	 * `close()` is not optional here. Cloudflare's
	 * `web_socket_auto_reply_to_close` flag would send the closing frame back
	 * for us, and it is off at this worker's compatibility date, so without
	 * this call the peer never receives one and observes a `1006` abnormal
	 * closure instead of the clean shutdown it asked for. A reconnect backoff
	 * that treats `1006` as a fault therefore treats every ordinary tab close
	 * as an error.
	 */
	override async webSocketClose(
		socket: WebSocket,
		code: number,
		reason: string,
	): Promise<void> {
		this.forget(socket);
		// 1005 means "no status received", which is not a code a close frame may
		// carry back; 1006 is never sendable at all.
		socket.close(code === 1005 || code === 1006 ? 1000 : code, reason);
		await this.scheduleAuthorizationAlarm();
	}

	override webSocketError(socket: WebSocket): void {
		this.forget(socket);
	}

	private forget(socket: WebSocket): void {
		const connection = this.connections.get(socket);
		if (connection !== undefined) this.hub.leave(connection);
		this.connections.delete(socket);
	}

	/** Missing attachments from older sockets fail closed rather than renew. */
	private isAuthorized(socket: WebSocket): boolean {
		if (socket.readyState !== WebSocket.OPEN) return false;
		const deadline = attachmentOf(socket)?.authorizedUntil;
		if (
			typeof deadline === 'number' &&
			Number.isFinite(deadline) &&
			Date.now() < deadline
		)
			return true;
		this.forget(socket);
		socket.close(1008, 'socket authorization expired');
		return false;
	}

	/** Alarms wake idle objects; every data path also checks for late alarms. */
	override async alarm(): Promise<void> {
		await this.scheduleAuthorizationAlarm();
	}

	private async scheduleAuthorizationAlarm(): Promise<void> {
		const current = await this.ctx.storage.getAlarm();
		let earliest = Infinity;
		for (const socket of this.ctx.getWebSockets()) {
			if (!this.isAuthorized(socket)) continue;
			earliest = Math.min(earliest, attachmentOf(socket)!.authorizedUntil);
		}
		if (earliest === Infinity) {
			if (current !== null) await this.ctx.storage.deleteAlarm();
		} else if (current !== earliest) {
			await this.ctx.storage.setAlarm(earliest);
		}
	}

	/**
	 * Throw this partition's whole log away. Account deletion only.
	 *
	 * One authority holds one application's document, so this is one dataId's
	 * data. Deleting an ACCOUNT means calling it once per dataId; the list is
	 * `DELETABLE_NAMESPACES` and its limits are documented there.
	 */
	async deleteStore(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
