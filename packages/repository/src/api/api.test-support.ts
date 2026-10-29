/**
 * Two people's devices on one server, for the repository API's tests: each
 * a replica in this process whose requests the test answers by hand
 * (`sync`), and a repository over it whose host can hold the worker's
 * answers (`hold`, `release`) so a test decides what is in flight.
 */
import { unwrap } from 'wellcrafted/result';
import { openBunSqlite } from '../bun/sqlite.js';
import type { Reply, Request } from '../client/replica.js';
import { openReplica, type Replica } from '../client/replica.js';
import type { App, Definitions } from '../core/lens.js';
import type { Server } from '../server/server.js';
import type { SqlDriver } from '../sql.js';
import { createTestServer, writer } from '../sim/harness.js';
import { createLocalHost } from './local.js';
import { type Host, type HostState, openRepository, type Session } from './repository.js';

/** Let every answer and change in flight arrive. */
export const settled = () => new Promise((resolve) => setTimeout(resolve, 0));

function answer(server: Server, request: Request, user: string): Reply {
	switch (request.type) {
		case 'push':
			return { type: 'answer', rid: request.rid, answer: server.push(request.commit, writer(user)) };
		case 'catch-up':
			return { type: 'caught-up', rid: request.rid, catchUp: server.catchUp(request) };
		case 'fetch':
			return { type: 'fetched', rid: request.rid, texts: server.fetch(request.hashes) };
	}
}

/** A host whose session's answers to writes can be held, so a test types while one is in flight. */
function holding(inner: Host) {
	let holdingAnswers = false;
	const held: (() => void)[] = [];
	const sessions = new WeakMap<Session, Session>();
	const wrap = (session: Session): Session => {
		let wrapped = sessions.get(session);
		if (wrapped === undefined) {
			wrapped = {
				...session,
				change(changes, token) {
					// Applied now, in order, as the worker applies it; only its answer waits.
					const answered = session.change(changes, token);
					if (!holdingAnswers) return answered;
					// A held answer that rejects (its session ended) is the caller's once released, not an unhandled rejection meanwhile.
					answered.catch(() => {});
					return new Promise((resolve, reject) => held.push(() => answered.then(resolve, reject)));
				},
			};
			sessions.set(session, wrapped);
		}
		return wrapped;
	};
	const host: Host = {
		subscribe: (onState) => inner.subscribe((state: HostState) => onState(state.status === 'open' ? { status: 'open', session: wrap(state.session) } : state)),
		close: () => inner.close(),
	};
	return {
		host,
		hold() {
			holdingAnswers = true;
		},
		/** Let the held answers go, in order, and answer the rest at once. */
		release() {
			holdingAnswers = false;
			for (const go of held.splice(0)) go();
		},
	};
}

/** Two devices of one repository, `alice` with a repository over her replica, `bob` with his replica alone. */
export function twoDevices<TDefs extends Definitions>(app: App<TDefs>) {
	const server = createTestServer();
	const device = (user: string) => {
		const driver = openBunSqlite();
		/** While set, the next stored change fails, as a full disk's does. */
		let failing = false;
		const faulty: SqlDriver = {
			...driver,
			run(sql, params) {
				if (failing && /^\s*(INSERT|UPDATE|DELETE)/i.test(sql)) throw new Error('disk I/O error');
				driver.run(sql, params);
			},
		};
		const replica = unwrap(openReplica({ driver: faulty, binding: { repository: 'r', server: null, account: user }, device: `${user}-device`, app, after: () => {}, now: () => 0 }));
		const sent: Request[] = [];
		replica.attach((request) => sent.push(request));
		unwrap(replica.hello({ repository: 'r', server: 'test', account: user, user, main: server.main() }));
		return {
			replica,
			/** Make every stored change fail until called with false. */
			fail(on = true) {
				failing = on;
			},
			/** Answer every request this device sends, until it sends none. */
			sync() {
				for (let request = sent.shift(); request !== undefined; request = sent.shift()) replica.reply(answer(server, request, user));
			},
			/** Hear what is on the server now. */
			catchUp() {
				unwrap(replica.hello({ repository: 'r', server: 'test', account: user, user, main: server.main() }));
				this.sync();
			},
		};
	};
	const alice = device('alice');
	const bob = device('bob');
	const local = createLocalHost({ replica: alice.replica, app });
	const gate = holding(local.host);
	const repo = openRepository({ app, host: gate.host });
	return { server, alice, bob, local, gate, repo };
}

export type { Replica };
