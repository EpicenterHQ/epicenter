/**
 * THROWAWAY. One Durable Object per application partition, and a page.
 *
 * The Durable Object is a thin adapter and nothing more: every rule about who
 * has been sent what lives in `@epicenter/app/sync`, so what runs here and
 * what the tests drive are the same object rather than two that agree today.
 *
 * Delete this app once the transport is settled. It exists because `wrangler
 * dev` cannot trigger hibernation eviction honestly and because two devices on
 * one deployed URL is the only evidence that counts.
 */
import { DurableObject } from 'cloudflare:workers';
import {
	createSyncHub,
	type HubConnection,
	openSyncAuthority,
	type SyncAuthority,
	type SyncHub,
} from '@epicenter/app/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

type Env = {
	SYNC: DurableObjectNamespace;
	ASSETS: { fetch(request: Request): Promise<Response> };
};

/**
 * A socket's position and declared document, kept where they survive
 * hibernation.
 *
 * The in-memory map is the fast path and the attachment is the fallback. They
 * can disagree only in the safe direction: a woken object reads a position that
 * is behind, re-sends entries the replica already has, and every one of them is
 * idempotent. The other direction would skip. The document is set once at the
 * dial and never moves.
 */
function attachmentOf(socket: WebSocket): { cursor: number } {
	const attached = socket.deserializeAttachment() as { cursor?: number } | null;
	return { cursor: attached?.cursor ?? 0 };
}

export class SyncLabAuthority extends DurableObject {
	private readonly authority: SyncAuthority;
	private readonly hub: SyncHub;
	/** One connection object per live socket, so the hub sees stable identities. */
	private readonly connections = new Map<WebSocket, HubConnection>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env as never);
		const sqlite = createDurableObjectSqliteAdapter(
			ctx.storage as unknown as DurableObjectSqliteStorage,
		);
		this.authority = openSyncAuthority({ sqlite });
		this.hub = createSyncHub({ authority: this.authority });
		// A woken object has sockets and nothing else: no map, and a hub that has
		// never heard of them. Both are rebuilt here, before any message can
		// arrive. Their positions come from the attachments they carry.
		for (const socket of ctx.getWebSockets()) this.adopt(socket);
	}

	/**
	 * Wrap one socket as a connection, attach it to the hub, and keep its
	 * position durable.
	 *
	 * Joining is not separable from wrapping, and a wake is what proves it. The
	 * hub drops a message from a connection it has not joined, silently and by
	 * design, so an object that rebuilt only `connections` was deaf and mute: it
	 * took every push, stored none of them, never acknowledged and never refused,
	 * and relayed nothing to the other sockets. A replica cannot tell that apart
	 * from a network that has gone quiet, so it holds the work forever believing
	 * it is in transit.
	 *
	 * Joining also runs catch-up, which on a wake is the whole recovery: the
	 * cursor comes from the attachment, which is BEHIND what was really sent, so
	 * entries go out again rather than being skipped.
	 */
	private adopt(socket: WebSocket): HubConnection | undefined {
		const existing = this.connections.get(socket);
		if (existing !== undefined) return existing;
		let written = attachmentOf(socket).cursor;
		const connection: HubConnection = {
			cursor: written,
			send(bytes) {
				if (socket.readyState !== WebSocket.OPEN) return;
				socket.send(bytes);
				// `serializeAttachment` is a DURABLE STORAGE WRITE, and this used to
				// run on every frame. A chunked entry relayed to two sockets was
				// several writes of a value that had not changed, so the cost scaled
				// with traffic rather than with progress.
				//
				// Written after the send rather than before, so a failure leaves the
				// position behind rather than ahead, and only when it actually moved.
				// Lagging by one entry is the safe direction: a wake re-sends what the
				// replica already has, which is idempotent.
				if (connection.cursor === written) return;
				written = connection.cursor;
				socket.serializeAttachment({ cursor: written });
			},
		};
		if (this.hub.join(connection) !== 'admitted') {
			// The same door as the deployed adapter: storage that cannot be read
			// seats nobody, and there is nothing else left to refuse (ADR-0292).
			socket.close(1000, 'authority unavailable');
			return undefined;
		}
		this.connections.set(socket, connection);
		return connection;
	}

	override async fetch(request: Request): Promise<Response> {
		if (request.headers.get('Upgrade') !== 'websocket') {
			return new Response('expected a websocket', { status: 426 });
		}
		const query = new URL(request.url).searchParams;
		const asked = Number(query.get('cursor') ?? '0');
		const cursor = Number.isFinite(asked) && asked >= 0 ? asked : 0;
		const declared = query.get('document');
		const documentId =
			declared !== null && declared.length > 0 && declared.length <= 128
				? declared
				: undefined;
		const pair = new WebSocketPair();
		const client = pair[0];
		const server = pair[1];

		this.ctx.acceptWebSocket(server);
		// Written before adopting, because the attachment is where a position
		// comes from: this is the one place it is set from a request rather than
		// read back off the socket, and there is no second source of truth.
		server.serializeAttachment({
			cursor,
			...(documentId === undefined ? {} : { document: documentId }),
		});
		// Adopting decides everything (ADR-0231): a servable connection joins
		// the hub and catch-up runs here, synchronously, before this handler
		// returns, so the replica's contiguity check holds by construction; a
		// bootstrap or retired one is answered with the announcement and closed.
		this.adopt(server);

		return new Response(null, { status: 101, webSocket: client });
	}

	override webSocketMessage(
		socket: WebSocket,
		message: ArrayBuffer | string,
	): void {
		if (typeof message === 'string') return;
		// Nothing thrown. `workerd` swallows a throw here without closing the
		// socket, so a refusal has to travel as a frame; the hub sends one.
		const connection = this.adopt(socket);
		if (connection === undefined) return;
		this.hub.receive(connection, new Uint8Array(message));
	}

	override webSocketClose(socket: WebSocket): void {
		this.forget(socket);
	}

	override webSocketError(socket: WebSocket): void {
		this.forget(socket);
	}

	private forget(socket: WebSocket): void {
		const connection = this.connections.get(socket);
		if (connection !== undefined) this.hub.leave(connection);
		this.connections.delete(socket);
	}

	/**
	 * What the authority is holding.
	 *
	 * `storedBytes` is the number to watch and it should now be FLAT over time
	 * rather than growing: a snapshot replaces the entries it covers, so the
	 * authority holds about one state plus a short tail forever.
	 */
	stat(): {
		head: number;
		snapshot: number;
		entries: number;
		storedBytes: number;
		sockets: number;
		incarnation: string;
	} {
		return {
			head: this.authority.head().data ?? 0,
			// Reported separately from the head, because a snapshot does not move
			// the head and the two are indistinguishable without it: a run where
			// nothing was ever snapshotted and one where everything was look
			// identical from `head` alone.
			snapshot: this.authority.snapshotPosition().data ?? 0,
			entries: this.authority.since(0, 1_000_000).data?.length ?? 0,
			storedBytes: this.authority.storedBytes().data ?? 0,
			sockets: this.ctx.getWebSockets().length,
			// Minted per constructor. A run that reports the same value at its start
			// and its end drove ONE live object; a value that changed means the
			// object was evicted and restarted, and a "sustained through one
			// instance" claim made across that boundary is not established. A single
			// message through a fresh isolate is the flattering case, and it is
			// exactly the error that produced this branch's wrong memory numbers.
			incarnation: this.incarnation,
		};
	}

	private readonly incarnation = crypto.randomUUID();

	/**
	 * Where Durable Object SQLite actually refuses a value.
	 *
	 * Tested at the byte rather than at a comfortable 3 MB, because a limit
	 * probed with a wide margin tells you the margin and not the limit. Each
	 * size is written and then deleted, so the probe leaves nothing behind.
	 */
	probeValueCap(
		sizes: readonly number[],
	): { size: number; stored: boolean; failure?: string }[] {
		const storage = this.ctx.storage as unknown as DurableObjectSqliteStorage;
		storage.sql.exec(
			'CREATE TABLE IF NOT EXISTS _probe (id INTEGER PRIMARY KEY, bytes BLOB)',
		);
		return sizes.map((size) => {
			try {
				storage.sql.exec('DELETE FROM _probe');
				storage.sql.exec(
					'INSERT INTO _probe (id, bytes) VALUES (1, ?)',
					new Uint8Array(size),
				);
				const read = storage.sql
					.exec<{ n: number }>(
						'SELECT length(bytes) AS n FROM _probe WHERE id = 1',
					)
					.toArray()[0];
				storage.sql.exec('DELETE FROM _probe');
				// Written AND read back at the same length. A write that silently
				// truncated would otherwise report success.
				return { size, stored: read?.n === size };
			} catch (cause) {
				return {
					size,
					stored: false,
					failure: cause instanceof Error ? cause.message : String(cause),
				};
			}
		});
	}

	/**
	 * Throw everything away between probe runs. Throwaway app only.
	 *
	 * Both relations. Clearing the log alone left the snapshot behind, and since
	 * a snapshot carries the whole state, one experiment's data leaked into the
	 * next and a control caught it as an off-by-one row count.
	 */
	reset(): void {
		this.ctx.storage.sql.exec('DELETE FROM _log');
		this.ctx.storage.sql.exec('DELETE FROM _snapshot');
	}
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const application = url.searchParams.get('app') ?? 'lab';
		const stub = env.SYNC.get(
			env.SYNC.idFromName(application),
		) as unknown as SyncLabAuthority;

		switch (url.pathname) {
			case '/sync':
				return (
					stub as unknown as { fetch(request: Request): Promise<Response> }
				).fetch(request);
			case '/stat':
				return Response.json(await stub.stat());
			case '/probe/value-cap': {
				const sizes = (url.searchParams.get('sizes') ?? '')
					.split(',')
					.map((size) => Number(size))
					.filter((size) => Number.isFinite(size) && size >= 0);
				return Response.json(await stub.probeValueCap(sizes));
			}
			case '/probe/reset':
				await stub.reset();
				return Response.json({ reset: true });
			default:
				return env.ASSETS.fetch(request);
		}
	},
};
