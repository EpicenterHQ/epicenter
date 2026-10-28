/**
 * The leader's worker: it owns the repository's SQLite database and its
 * connection to the server, runs the whole engine, and answers every tab on
 * the repository's BroadcastChannel. A tab starts it only after taking the
 * repository's Web Lock, so one runs per repository per origin.
 */
import type { TSchema } from 'typebox';
import { createLogger } from 'wellcrafted/logger';
import { type Definitions, defineApp } from '../define.js';
import { openEngine } from '../engine/engine.js';
import { offlineTransport } from '../engine/ports.js';
import { createWebSocketTransport } from '../ws/client.js';
import { channelName, type Described, type Init, type LeaderMessage, type TabMessage } from './messages.js';
import { openOpfsDatabase } from './sqlite.js';

const log = createLogger('repository/browser-worker');

/** The engine reads only field names from a schema; validation stays in the tabs. */
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

/** Serve one repository from this worker once its tab sends `Init`. */
export function serveRepositoryWorker() {
	addEventListener('message', (event: MessageEvent<Init>) => {
		if (event.data?.type === 'init') void start(event.data);
	});
}

async function start({ name, definitions, server }: Init) {
	const channel = new BroadcastChannel(channelName(name));
	let dropSubmitAnswers = false;
	const post = (message: LeaderMessage) => channel.postMessage(message);
	const driver = await openOpfsDatabase(name);
	if (driver.error !== null) {
		log.error(driver.error);
		post({ type: 'unavailable', reason: driver.error.message });
		return;
	}
	const engine = openEngine({
		app: defineApp(definitionsOf(definitions)),
		driver: driver.data,
		transport: server === null ? offlineTransport : createWebSocketTransport(server),
		log,
	});
	const leader = crypto.randomUUID();
	engine.onChange((paths) => post({ type: 'changed', paths }));
	channel.onmessage = (event: MessageEvent<TabMessage>) => {
		const message = event.data;
		switch (message.type) {
			case 'hello':
				post({ type: 'leader', leader });
				return;
			case 'read': {
				const { tab, id } = message;
				engine.read(message.request).then(
					(value) => post({ type: 'answer', tab, id, value }),
					(cause: unknown) => post({ type: 'failed', tab, id, reason: String(cause) }),
				);
				return;
			}
			case 'submit': {
				const { tab, id } = message;
				const submitted = engine.submit(id, message.ops);
				// Outcomes are JSON; an error's `cause` may not be cloneable, so it goes as JSON too.
				const plain = <T>(result: T): T => JSON.parse(JSON.stringify(result));
				void submitted.local.then((result) => dropSubmitAnswers || post({ type: 'local', tab, id, result: plain(result) }));
				void submitted.settled.then((result) => dropSubmitAnswers || post({ type: 'settled', tab, id, result: plain(result) }));
				return;
			}
			case 'test:drop-submit-answers':
				dropSubmitAnswers = true;
				return;
			default:
				message satisfies never;
		}
	};
	post({ type: 'leader', leader });
}
