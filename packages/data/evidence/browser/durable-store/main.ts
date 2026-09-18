/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';

import { openDatabase, resolveGeneration } from '../../../src/store/browser.js';
import type { ReplicaData } from '../../../src/store/store.js';

/**
 * Two namespaces, because a dataId is what makes two stores two stores.
 *
 * The control below used to open one dataId under a second NAME and call
 * that a different file. A workspace names the store it opens (ADR-0229), so there
 * is no second name left to vary, and the honest control is a second dataId.
 */
const workspaces = {
	vault: defineData({
		id: 'so.epicenter.durableprobe',
		kv: {},
		tables: {
			notes: defineTable({
				title: field.string(),
				content: plainText(),
			}),
		},
	}),
	'somewhere-else': defineData({
		id: 'so.epicenter.durableprobe.elsewhere',
		kv: {},
		tables: {
			notes: defineTable({
				title: field.string(),
				content: plainText(),
			}),
		},
	}),
} as const;

type ProbeApplication = ReplicaData<(typeof workspaces)['vault']>;

/** The application this probe opens as, which is the address's first segment. */
const PROBE_APP = 'so.epicenter.durability-probe';

/**
 * The account this probe's store belongs to (ADR-0325).
 *
 * Durability is the subject here, so no real authority is reached. Its `fetch`
 * is a stub authority rather than a throw, because `resolveGeneration` asks one
 * which generations exist before it mints: an empty listing is a first run, and
 * the POST that follows is what assigns the number.
 */
const PROBE_ACCOUNT = {
	baseURL: 'https://probe.invalid',
	authorityId: 'probe-authority',
	principalId: 'probe' as never,
	fetch: (async (_input: string | URL, init?: RequestInit) =>
		new Response(
			JSON.stringify(
				init?.method === 'POST'
					? { generation: 1, position: 0 }
					: { generations: [] },
			),
			{ headers: { 'content-type': 'application/json' } },
		)) as never,
	// The probe opens and reloads; it never dials, so a socket that threw would
	// be as good as one that never resolves. `WebSocket` was the pre-0346
	// spelling of the same absence.
	openWebSocket: (() => {
		throw new Error('the durable-store probe never dials');
	}) as never,
};

let db: ProbeApplication | undefined;

function bound(): ProbeApplication {
	if (db === undefined) throw new Error('open a store first');
	return db;
}

const out = document.querySelector('#out') as HTMLElement;
function show(value: unknown): void {
	out.textContent = JSON.stringify(value, null, 2);
}

Object.assign(globalThis, {
	async open(name: keyof typeof workspaces) {
		const workspace = workspaces[name];
		if (workspace === undefined) return { error: `no workspace named ${name}` };
		// One decision, the same one every application makes: this device's copy
		// if it holds one, and a mint only because the stub listing is empty
		// (ADR-0292, ADR-0293). The second open of the same page is a cache hit
		// and creates nothing, which is what the reload below is checking.
		const resolved = await resolveGeneration(workspace, {
			appId: PROBE_APP,
			account: PROBE_ACCOUNT,
		});
		if (resolved.error !== null) return { error: resolved.error.message };
		const opened = await openDatabase(workspace, {
			appId: PROBE_APP,
			generation: resolved.data.generation,
			account: PROBE_ACCOUNT,
		});
		if (opened.error !== null) {
			const cause = (opened.error as { cause?: unknown }).cause;
			return {
				error: opened.error.message,
				cause: cause instanceof Error ? cause.message : String(cause),
			};
		}
		// The probe never closes: the page reload IS the close it is testing.
		db = opened.data.store;
		show({ opened: name, dataId: workspace.id });
		return { ok: true };
	},

	/** Create a note AND write text into its content node, then wait for durability. */
	async write(title: string, text: string) {
		const db = bound();
		const made = db.tables.notes.create({ title });
		const content = db.tables.notes.get(made.id)?.content;
		if (content === undefined) return { error: 'the row has no content' };
		content.applyDelta(content.change.insert(text) as never);
		await db.persistence.flush();
		return {
			id: made.id,
			durable: db.persistence.get() === 'saved',
		};
	},

	/** Everything this store can see right now, node text and all. */
	async read() {
		const db = bound();
		const listed = db.tables.notes;
		const notes: { title: string; text: string }[] = [];
		for (const row of listed.rows) {
			// Through the CRDT, not through a cache the harness keeps.
			notes.push({
				title: row.title,
				text: JSON.stringify(
					db.tables.notes.get(row.id)?.content.toJSON() ?? null,
				),
			});
		}
		return {
			notes: notes.sort((left, right) => left.title.localeCompare(right.title)),
			durability: { healthy: db.persistence.get() !== 'blocked' },
			pressure: db.pressure(),
		};
	},
});

show({ ready: true });
