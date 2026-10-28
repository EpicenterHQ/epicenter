/**
 * The owning tab's worker: it holds the repository's SQLite database and its
 * connection to the server, runs the whole engine, and answers its one tab.
 * The tab starts it only while holding the repository's Web Lock, and tells
 * it to close before giving the lock up, so one runs per repository per
 * origin, apart from the moments when an old one is still letting go.
 */
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import { type Definitions, defineApp } from '../define.js';
import { type Engine, openEngine } from '../engine/engine.js';
import { offlineTransport } from '../engine/ports.js';
import type { SqlDriver } from '../sql.js';
import { createWebSocketTransport } from '../ws/client.js';
import type { Described, Init, TabMessage, WorkerMessage } from './messages.js';
import { openOpfsDatabase } from './sqlite.js';

const log = createLogger('repository/browser-worker');

/** The engine reads only field names from a schema; validation stays in the tab. */
function definitionsOf(described: Described): Definitions {
	return Object.fromEntries(
		Object.entries(described).map(([name, definition]) => [
			name,
			'fields' in definition
				? { path: definition.path, schema: { properties: Object.fromEntries(definition.fields.map((field) => [field, {}])) } as unknown as TSchema }
				: definition,
		]),
	);
}

const post = (message: WorkerMessage) => postMessage(message);

/** Outcomes are JSON; an error's `cause` may not be cloneable, so it goes as JSON too. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value));

/** Serve one repository from this worker once its tab sends `Init`. */
export function serveRepositoryWorker() {
	let engine: Engine | null = null;
	let driver: SqlDriver | null = null;
	let closing = false;
	/** Calls that arrived before the database opened, answered in order once it does. */
	const early: Extract<TabMessage, { type: 'read' | 'submit' }>[] = [];
	/** Writes still storing blob bytes, which a close waits for. */
	const writing = new Set<Promise<unknown>>();

	function handle(message: TabMessage) {
		switch (message.type) {
			case 'init':
				void start(message);
				return;
			case 'close':
				closing = true;
				// Before the database opens, `start` sees `closing` and closes it.
				if (engine !== null) void close();
				return;
			case 'read':
			case 'submit':
				if (engine === null) {
					early.push(message);
					return;
				}
				call(engine, message);
				return;
			default:
				message satisfies never;
		}
	}

	function call(engine: Engine, message: Extract<TabMessage, { type: 'read' | 'submit' }>) {
		const { id } = message;
		if (message.type === 'read') {
			engine.read(message.request).then(
				(value) => post({ type: 'answer', id, value }),
				(cause: unknown) => post({ type: 'failed', id, reason: String(cause) }),
			);
			return;
		}
		const submitted = engine.submit(message.ops);
		const local = submitted.local.then((result) => post({ type: 'local', id, result: plain(result) }));
		writing.add(local);
		void local.finally(() => writing.delete(local));
		void submitted.settled.then((result) => post({ type: 'settled', id, result: plain(result) }));
	}

	async function start({ name, definitions, server }: Init) {
		const opened = await openOpfsDatabase(name, {
			onWaiting: (reason) => post({ type: 'waiting', reason }),
			cancelled: () => closing,
		});
		if (closing) {
			if (opened.error === null) opened.data.close();
			post({ type: 'closed' });
			return;
		}
		if (opened.error !== null) {
			log.error(opened.error);
			post({ type: 'unavailable', reason: opened.error.message });
			return;
		}
		driver = opened.data;
		engine = openEngine({
			app: defineApp(definitionsOf(definitions)),
			driver,
			transport: server === null ? offlineTransport : createWebSocketTransport(server),
			log,
		});
		engine.onChange((paths) => post({ type: 'changed', paths }));
		post({ type: 'ready' });
		for (const message of early.splice(0)) call(engine, message);
	}

	async function close() {
		await Promise.all(writing);
		engine?.close();
		driver?.close();
		engine = null;
		driver = null;
		post({ type: 'closed' });
	}

	addEventListener('message', (event: MessageEvent<TabMessage>) => handle(event.data));
}
