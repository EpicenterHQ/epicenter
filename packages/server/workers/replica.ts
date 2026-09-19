import { defineApp, defineTable, field, plainText } from '@epicenter/app';
import type { ReplicaData } from '@epicenter/app/store';
/**
 * Test-only: a replica that lives inside `workerd`, driven by the real driver.
 *
 * It is a Durable Object for one reason. A replica is an `DataDocument`, a
 * store's durable record is SQLite here, and the only synchronous SQLite
 * inside `workerd` is a Durable Object's own storage. Everything else here is
 * the deployed client: `openData` for the store, `attachStoreSync`
 * for the dial, over the real routes, so a test can assert on the rows a
 * device actually holds rather than on frames a harness counted.
 *
 * `attachStoreSync` rather than a dial written here, because a second dial
 * passes over a handshake no browser makes (ADR-0346). What this file supplies
 * is the one thing a Worker cannot borrow, a `SocketTransport` over
 * `env.SELF.fetch`, and nothing else.
 *
 * The probe downloads the canonical current baseline before its first dial.
 * It exercises real sync and storage, not the browser IndexedDB bootstrap.
 *
 * Not exported from `index.ts` and not in any `wrangler.jsonc`. Only the test
 * entry mounts it, so nothing deployable grows a class that exists for a test.
 */

import { DurableObject } from 'cloudflare:workers';

import { openData, syncEngineOf } from '@epicenter/app/data';
import { attachStoreSync, type SyncConnection } from '@epicenter/app/sync';
import { asPrincipalId } from '@epicenter/principal';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import {
	bearerSubprotocol,
	formatSubprotocols,
	type SocketTransport,
} from '@epicenter/sync';
import { readCurrentDownload } from '@epicenter/sync/current-download';
import { CURRENT_ROUTE } from '@epicenter/sync/generations-route';
import { expectOk } from 'wellcrafted/testing';

/** This harness covers fresh stores; restore admission has its own Worker suite. */
const PROBE_GENERATION = 1;

const probeDefinition = defineApp({
	id: 'so.epicenter.storeprobe',
	kv: {},
	tables: {
		notes: defineTable({
			title: field.string(),
			content: plainText(),
		}),
	},
});

type ProbeReplica = ReplicaData<typeof probeDefinition>;

export type ReplicaReport = {
	cursor: number;

	connected: boolean;
	titles: string[];
	text: string[];
	lastError: string | undefined;
	/** Structs the engine holds; how a test sees tombstones reclaimed. */
	items: number;
};

type Env = { SELF: Fetcher };

export class StoreTestReplica extends DurableObject<Env> {
	private connection: SyncConnection | undefined;
	private store: ProbeReplica | undefined;
	private bearer = '';
	private lastTransportError: string | undefined;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * Open this replica as `bearer`, and dial unless told to stay offline.
	 *
	 * `connect: false` is how a test models a device that works offline first:
	 * it writes locally and only `startSync()`s later, which is exactly the
	 * device the stated-loss contract is about.
	 */
	async open(
		bearer: string,
		origin: string,
		{ connect = true }: { connect?: boolean } = {},
	): Promise<void> {
		if (this.store !== undefined) return;
		await this.ctx.blockConcurrencyWhile(async () => {
			if (this.store !== undefined) return;
			this.bearer = bearer;
			const database = createDurableObjectSqliteAdapter(
				this.ctx.storage as unknown as DurableObjectSqliteStorage,
			);
			// The test replica captures its address before any asynchronous dial.
			this.store = Object.freeze({
				...(await openData(probeDefinition, database)),
				appId: probeDefinition.id,
				dataId: probeDefinition.id,
				generation: PROBE_GENERATION,
				baseURL: origin,
				principalId: asPrincipalId(bearer.replace(/^device:/, '')),
			});
			const response = await this.env.SELF.fetch(
				CURRENT_ROUTE.url(
					origin,
					probeDefinition.id,
					'personal',
					probeDefinition.id,
				),
				{
					method: 'POST',
					headers: { authorization: `Bearer ${bearer}` },
					body: new Uint8Array(this.store.encodeStateSince()).buffer,
				},
			);
			const current = await readCurrentDownload(response);
			if (current.generation !== PROBE_GENERATION)
				throw new Error('Probe expects generation one');
			expectOk(
				syncEngineOf(this.store).applyRemote(current.snapshot.bytes, {
					advanceTo: current.snapshot.position,
				}),
			);
			for (const entry of current.tail)
				expectOk(
					syncEngineOf(this.store).applyRemote(entry.bytes, {
						advanceTo: entry.seq,
					}),
				);
			await this.store.persistence.flush();
		});
		if (connect) this.startSync();
	}

	/**
	 * How this replica reaches the worker, and the only thing here a page does
	 * not do verbatim.
	 *
	 * A Worker has no `new WebSocket` that can reach `SELF`, so the upgrade is a
	 * `fetch`, and the credential list a browser hands the constructor is
	 * written into the header by hand: `bearerSubprotocol` appends the bearer
	 * to the address the route built, and `formatSubprotocols` writes the
	 * header the constructor would have written. Both come from
	 * `@epicenter/sync`, so the header this offers is the header a browser
	 * offers.
	 */
	private transport(): SocketTransport {
		const bearer = this.bearer;
		return {
			openWebSocket: async (address) => {
				const response = await this.env.SELF.fetch(
					new Request(address.url.replace(/^ws/, 'http'), {
						headers: {
							Upgrade: 'websocket',
							'sec-websocket-protocol': formatSubprotocols([
								...address.protocols,
								bearerSubprotocol(bearer),
							]),
						},
					}),
				);
				// `null`, not `undefined`, on a refused upgrade in workerd: the
				// property exists on every Response and holds nothing. Thrown rather
				// than reported, because a rejection is what `attachStoreSync` reads
				// as a transport failure, and a refusal from this route is transient
				// by construction: nothing here can classify it as a denial.
				const accepted = response.webSocket;
				if (accepted === null) {
					throw new Error(`the upgrade was refused with ${response.status}`);
				}
				// Already open once accepted, and it never fires `open`.
				accepted.accept();
				return accepted;
			},
		};
	}

	/** Start dialling, with the deployed driver and the real supersession rule. */
	startSync(): void {
		const store = this.store;
		if (store === undefined) throw new Error('open first');
		if (this.connection !== undefined) return;
		this.connection = attachStoreSync({
			onRetired: () => {
				this.lastTransportError = 'Replica generation retired';
				this.stopSync();
			},
			store,
			address: { ...store, scope: 'personal' },
			transport: this.transport(),
			onTransportError: (cause) => {
				this.lastTransportError = String(cause);
			},
		});
	}

	/** Stop dialling, the way a device going offline does. Work keeps queuing. */
	stopSync(): void {
		this.connection?.[Symbol.dispose]();
		this.connection = undefined;
	}

	/** Create a note with body text, the way an application does. */
	write(title: string, text: string): void {
		const store = this.store;
		if (store === undefined) throw new Error('open first');
		const made = store.tables.notes.create({ title });
		const content = store.tables.notes.get(made.id)?.content;
		if (content === undefined) throw new Error('the row has no content');
		content.applyDelta(content.change.insert(text) as never);
	}

	/** Delete the note holding this title, the way an application does. */
	remove(title: string): void {
		const store = this.store;
		if (store === undefined) throw new Error('open first');
		const listed = store.tables.notes;
		const row = listed.rows.find((candidate) => candidate.title === title);
		if (row === undefined) throw new Error(`no note titled '${title}'`);
		listed.delete(row.id);
	}

	/**
	 * What this replica actually holds, read back out of its own SQLite.
	 *
	 * Tolerant of being asked before the store is open, because a test polls
	 * this while a boot is in flight: the answer is simply "nothing yet", and
	 * the next poll sees the opened store.
	 */
	async report(): Promise<ReplicaReport> {
		const store = this.store;
		if (store === undefined) {
			return {
				cursor: 0,
				connected: false,
				titles: [],
				text: [],
				lastError: undefined,
				items: 0,
			};
		}
		const listed = store.tables.notes;
		const status = this.connection?.status();
		const pressure = store.pressure();
		return {
			cursor: status?.cursor ?? 0,
			connected: status?.connected ?? false,
			titles: listed.rows.map((row) => row.title).sort(),
			text: listed.rows
				.map((row) =>
					JSON.stringify(listed.get(row.id)?.content.toJSON() ?? null),
				)
				.sort(),
			// A dial that failed is a failure a test wants to see as loudly as a
			// client error, so both report through the one field.
			lastError: status?.lastError?.name ?? this.lastTransportError,
			items: pressure.items,
		};
	}
}
