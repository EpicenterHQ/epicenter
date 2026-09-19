/**
 * The page half of the durability proof. Driven by `../durable-store.ts`.
 *
 * It exposes verbs rather than running a script, so the runner decides when a
 * reload happens, which is the only part of this that matters.
 */
import { defineApp, defineTable, field, plainText } from '@epicenter/app';

import { type App, openApp } from '@epicenter/app/open';

/**
 * Two namespaces, because a dataId is what makes two stores two stores.
 *
 * The control below used to open one dataId under a second NAME and call
 * that a different file. A workspace names the store it opens (ADR-0229), so there
 * is no second name left to vary, and the honest control is a second dataId.
 */
const workspaces = {
	vault: defineApp({
		id: 'so.epicenter.durableprobe',
		kv: {},
		tables: {
			notes: defineTable({
				title: field.string(),
				content: plainText(),
			}),
		},
	}),
	'somewhere-else': defineApp({
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

type ProbeApplication = App<(typeof workspaces)['vault']>['device'];

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
		try {
			// Reload ends the page. The probe reads the ready App-owned local store.
			db = (await openApp(workspace)).device;
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
		show({ opened: name, dataId: workspace.id });
		return { ok: true };
	},

	/** Write a row and its text; the runner can interrupt before persistence. */
	async write(title: string, text: string, flush = true) {
		const db = bound();
		const made = db.tables.notes.create({ title });
		const content = db.tables.notes.get(made.id)?.content;
		if (content === undefined) return { error: 'the row has no content' };
		content.applyDelta(content.change.insert(text) as never);
		if (flush) await db.persistence.flush();
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
