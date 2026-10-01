/**
 * THROWAWAY, and test-only: a peer that lives inside `workerd`.
 *
 * It is a Durable Object only because a Store needs synchronous SQLite and this
 * is the only such SQLite `workerd` supplies. This is NOT the browser storage
 * topology: a browser keeps its durable client facts in IndexedDB. The peer
 * keeps them in its one DO SQLite database through the engine seam
 * (`@epicenter/app/data`), so this Worker-runtime test can run the real
 * `openData`, `createSyncClient`, and WebSocket protocol against
 * the real authority.
 *
 * Therefore this fixture proves authority hibernation and protocol convergence,
 * not browser persistence. Browser storage behavior belongs in `packages/app/src/data`
 * browser tests.
 *
 * It is deliberately NOT exported from `worker/index.ts` and NOT in
 * `wrangler.jsonc`. Only `worker/test-entry.ts` mounts it, so nothing that
 * deploys grows a class that exists for a test.
 */
import { DurableObject } from 'cloudflare:workers';
import { defineStore, defineTable, field, plainText } from '@epicenter/app';
import { openData } from '@epicenter/app/data';
import {
	createSyncClient,
	decodeFrame,
	type SyncClient,
} from '@epicenter/app/sync';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';

const labDatabase = defineStore({
	id: 'so.epicenter.synclab',
	kv: {},
	tables: {
		notes: defineTable({
			fields: {
				title: field.string(),
				content: field.string(),
			},
			body: plainText(),
		}),
	},
});

/**
 * Open the lab database over this Durable Object's own SQLite.
 *
 * A named function rather than an inline call so `ReturnType<typeof openNotes>`
 * carries `notes` and its `title` column into the field type.
 */
function openNotes(
	sqlite: ReturnType<typeof createDurableObjectSqliteAdapter>,
) {
	return openData(labDatabase, sqlite);
}

/**
 * What a test is allowed to see, and all of it crosses RPC as plain data.
 *
 * `titles` is the assertion that matters: it is read out of the peer's own
 * SQLite through the database, so it can only be satisfied by bytes that arrived,
 * committed and applied. The two `redelivered` arrays are the opposite kind of
 * fact. They are an observation of the WIRE, kept because "a woken authority
 * re-sends rather than skips" is otherwise invisible from a converged peer:
 * a run that re-sent nothing and a run that re-sent and was correctly ignored
 * hold identical rows.
 */
export type TestPeerReport = {
	cursor: number;
	inFlight: boolean;
	needsResync: boolean;
	unresolvedDependencies: boolean;
	/** The error's tag, or undefined. Never a `SyncClientError` value: it carries a `cause`. */
	lastError: string | undefined;
	lastErrorMessage: string | undefined;
	titles: string[];
	/** Entry positions the authority sent again after this peer already held them. */
	redeliveredEntries: number[];
	/** Snapshot positions the authority sent again after this peer already held them. */
	redeliveredSnapshots: number[];
};

type Env = { SYNC: DurableObjectNamespace };

export class SyncLabTestPeer extends DurableObject<Env> {
	private readonly ready: Promise<{
		db: Awaited<ReturnType<typeof openNotes>>;
		client: SyncClient;
	}>;
	private readonly redeliveredEntries = new Set<number>();
	private readonly redeliveredSnapshots = new Set<number>();

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.ready = openNotes(
			createDurableObjectSqliteAdapter(
				ctx.storage as unknown as DurableObjectSqliteStorage,
			),
		).then((db) => ({
			db,
			// Explicit sends keep the test independent of an idle timer.
			client: createSyncClient({ store: db, idleMs: 60_000 }),
		}));
	}

	/**
	 * Open a real socket to the authority, from this peer's own cursor.
	 *
	 * First contact runs the identity handshake the deployed driver runs
	 * (ADR-0231): an identity-less dial only bootstraps. The authority names
	 * its document as the first frame and closes without admitting the
	 * connection; the client stamps the name durably, and the membership dial
	 * below goes through the equality door and is served like any other
	 * catch-up.
	 *
	 * Named `openSocket` rather than `connect` because a `DurableObjectStub` is a
	 * `Fetcher`, and `Fetcher.connect` is the built-in TCP socket API. A method
	 * called `connect` is never reached over RPC: the built-in wins, and it fails
	 * with the deeply unhelpful "Specified address is missing port".
	 */
	async openSocket(partition: string): Promise<void> {
		const { client } = await this.ready;
		const socket = await this.dial(partition, client);
		socket.accept();
		// Attached in the same synchronous turn as `accept()`, because catch-up
		// frames were already queued by the authority's `fetch` before it returned.
		socket.addEventListener('message', (event) => {
			if (typeof event.data === 'string') return;
			this.observe(new Uint8Array(event.data), client);
			client.receive(new Uint8Array(event.data));
		});
		socket.addEventListener('close', () => client.detach());
		client.attach({ send: (bytes) => socket.send(bytes) });
	}

	/** One upgrade at this peer's cursor. There is nothing else to declare. */
	private async dial(
		partition: string,
		client: SyncClient,
	): Promise<WebSocket> {
		const stub = this.env.SYNC.get(this.env.SYNC.idFromName(partition));
		const response = await stub.fetch(
			`https://sync-lab.invalid/sync?cursor=${client.cursor()}`,
			{ headers: { Upgrade: 'websocket' } },
		);
		const socket = response.webSocket;
		if (socket === null)
			throw new Error(`the authority answered ${response.status}`);
		return socket;
	}

	/**
	 * Note what the authority sent that this peer already had.
	 *
	 * Read BEFORE the frame reaches the client, because the client is what moves
	 * the cursor past it. `seq <= cursor` is the exact condition the client
	 * ignores, so this counts precisely the re-delivery the wake path produces.
	 */
	private observe(bytes: Uint8Array, client: SyncClient): void {
		const { data: frame, error } = decodeFrame(bytes);
		if (error !== null) return;
		const cursor = client.cursor();
		if (frame.kind === 'entry' && frame.seq <= cursor) {
			this.redeliveredEntries.add(frame.seq);
		}
		if (frame.kind === 'snapshot' && frame.position <= cursor) {
			this.redeliveredSnapshots.add(frame.position);
		}
	}

	/** Write one row and send it now. */
	async write(title: string): Promise<void> {
		const { db, client } = await this.ready;
		db.tables.notes.create({ title, content: '' });
		await db.persistence.flush();
		client.flush();
	}

	/**
	 * Write one row carrying `bytes` of body text, in one transaction.
	 *
	 * The only affordable way to reach the authority's 64 KB snapshot floor from
	 * a test: hundreds of small rows would take hundreds of round trips.
	 */
	async writeLarge(title: string, bytes: number): Promise<void> {
		const { db, client } = await this.ready;
		db.tables.notes.create({ title, content: 'x'.repeat(bytes) });
		await db.persistence.flush();
		client.flush();
	}

	async report(): Promise<TestPeerReport> {
		const { db, client } = await this.ready;
		const status = client.status();
		const listed = db.tables.notes;
		return {
			cursor: status.cursor,
			inFlight: status.inFlight,
			needsResync: status.needsResync,
			unresolvedDependencies: status.unresolvedDependencies,
			lastError: status.lastError?.name,
			lastErrorMessage: status.lastError?.message,
			titles: listed.rows.map((row) => row.title).sort(),
			redeliveredEntries: [...this.redeliveredEntries].sort((a, b) => a - b),
			redeliveredSnapshots: [...this.redeliveredSnapshots].sort(
				(a, b) => a - b,
			),
		};
	}
}
