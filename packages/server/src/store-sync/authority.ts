import { DurableObject } from 'cloudflare:workers';
import {
	type CurrentAuthority,
	encodeFrame,
	type HubConnection,
	openCurrentAuthority,
	type SyncHub,
} from '@epicenter/data/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import { createCurrentDownloadResponse } from '@epicenter/sync/current-download';
import type { ServerBindings } from '../server-bindings.js';

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
		generation: number;
		authorizedUntil: number;
	} | null;
}

export class StoreAuthority extends DurableObject {
	private readonly authority: CurrentAuthority;
	private readonly hubs = new Map<WebSocket, SyncHub>();
	/** One connection object per live socket, so the hub sees stable identities. */
	private readonly connections = new Map<WebSocket, HubConnection>();

	constructor(ctx: DurableObjectState, env: Cloudflare.Env & ServerBindings) {
		super(ctx, env);
		const sqlite = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.authority = openCurrentAuthority({ sqlite });
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
		if (!Number.isSafeInteger(attached.generation) || attached.generation < 1) {
			socket.close(1008, 'missing generation');
			return undefined;
		}
		const admitted = this.authority.createHub(attached.generation);
		if (admitted.error) {
			if (admitted.error.name === 'GenerationUnavailable')
				socket.send(encodeFrame({ kind: 'retired' }));
			socket.close(1000, 'generation unavailable');
			return undefined;
		}
		const hub = admitted.data;
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
		if (hub.join(connection) !== 'admitted') {
			// Storage that cannot be read: fail closed, with no membership and no
			// cache entry, so a frame arriving after this close re-runs admission
			// and meets the same verdict.
			socket.close(1000, 'authority unavailable');
			return undefined;
		}
		this.connections.set(socket, connection);
		this.hubs.set(socket, hub);
		// Catch-up may have closed the socket while the hub was joining it.
		if (!this.isAuthorized(socket)) {
			this.forget(socket);
			return undefined;
		}
		return connection;
	}

	/** Initialize and download through the same transaction owner as socket admission. */
	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			if (request.method !== 'POST')
				return new Response('Method not allowed', { status: 405 });
			// Bound streamed input too: Content-Length is not a trustworthy limit.
			const reader = request.body?.getReader();
			if (!reader)
				return new Response('A baseline is required', { status: 400 });
			const chunks: Uint8Array[] = [];
			let length = 0;
			while (true) {
				const part = await reader.read();
				if (part.done) break;
				length += part.value.byteLength;
				if (length > 16 * 1024 * 1024) {
					await reader.cancel();
					return new Response('Baseline too large', { status: 413 });
				}
				chunks.push(part.value);
			}
			if (!length)
				return new Response('A baseline is required', { status: 400 });
			const bytes = new Uint8Array(length);
			let offset = 0;
			for (const chunk of chunks) {
				bytes.set(chunk, offset);
				offset += chunk.length;
			}
			const current = this.authority.ensureCurrent(bytes);
			return createCurrentDownloadResponse(current);
		}
		const query = new URL(request.url).searchParams;
		const generation = Number(query.get('generation'));
		const cursor = Number(query.get('cursor') ?? '0');
		if (
			!Number.isSafeInteger(generation) ||
			generation < 1 ||
			!Number.isSafeInteger(cursor) ||
			cursor < 0
		)
			return new Response('Invalid sync address', { status: 400 });
		const pair = new WebSocketPair();
		this.ctx.acceptWebSocket(pair[1]);
		pair[1].serializeAttachment({
			cursor,
			generation,
			authorizedUntil: Date.now() + 600_000,
		});
		this.adopt(pair[1]);
		await this.scheduleAuthorizationAlarm();
		return new Response(null, { status: 101, webSocket: pair[0] });
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
		// The hibernated attachment preserves the generation this socket joined.
		const connection = this.adopt(socket);
		if (connection === undefined) return;
		this.hubs.get(socket)?.receive(connection, new Uint8Array(message));
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
		if (connection !== undefined) this.hubs.get(socket)?.leave(connection);
		this.connections.delete(socket);
		this.hubs.delete(socket);
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
