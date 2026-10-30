/**
 * The simulation's memory world: one server, a seeded network, and devices with
 * two channels each: requests (pushes, catch-ups, reads by hash), each
 * delayed on its own, lost, or answered with a reply that is lost; and a
 * notification stream, delayed and reordered per message, which a lost
 * message closes and which reopens and resumes by catching up. Devices go
 * offline and restart from their databases. The server flushes live
 * history after 60 s of quiet, at most every 5 minutes while busy, and on
 * demand.
 */

import { unwrap } from 'wellcrafted/result';
import { openBunSqlite } from '../bun/sqlite.js';
import {
	openReplica,
	type Reply,
	type Request,
	SEND_QUIET,
} from '../client/replica.js';
import { createMemoryGitStore } from '../server/memory-git.js';
import {
	type Committed,
	createServer,
	type Event,
	type Limits,
	SCHEDULE,
	type Session,
} from '../server/server.js';
import { createNet, type LinkOptions } from './net.js';

export const QUIET = SCHEDULE.quiet;
export const BUSY = SCHEDULE.busy;
/** The server's clock reads virtual time from this instant. */
export const EPOCH = Date.UTC(2026, 9, 28);
/** A commit time the server takes: the epoch, as an ISO instant. */
export const STAMP = new Date(EPOCH).toISOString();

/** The server's alarm on virtual time: each schedule replaces the last. */
export const virtualAlarm =
	(net: { now(): number; after(ms: number, run: () => void): void }) =>
	(due: () => void) => {
		let set = 0;
		return {
			schedule(at: number) {
				const mine = ++set;
				net.after(Math.max(0, at - (EPOCH + net.now())), () => {
					if (set === mine) due();
				});
			},
			cancel() {
				set++;
			},
		};
	};

/** A server alone over an in-memory Store and Git, for tests that push to it directly. */
export function createTestServer({
	clock = () => EPOCH,
	limits,
}: {
	clock?: () => number;
	limits?: Parameters<typeof createServer>[0]['limits'];
} = {}) {
	return createServer({
		store: openBunSqlite(),
		git: createMemoryGitStore(),
		clock,
		...(limits === undefined ? {} : { limits }),
	});
}

/** The memory world's binding for a person's replica. */
const BINDING = (account: string) => ({
	repository: 'test',
	server: 'memory',
	account,
});

/** A writer's session, as a host would verify it. */
export const writer = (user: string): Session => ({ user, role: 'writer' });

export function createWorld({
	seed = 1,
	latency = { min: 5, max: 40 },
	loss = { up: 0, down: 0 },
	streamLoss = 0,
	stall,
	timeout = 2_000,
	quiet = SEND_QUIET,
	limits,
	trace,
}: {
	seed?: number;
	latency?: LinkOptions['latency'];
	/** Chance a request, or its reply, is lost. */
	loss?: LinkOptions['loss'];
	/** Chance a notification is lost (closing the stream). */
	streamLoss?: number;
	/** Chance a request, reply or notification stalls, and for up to how long. */
	stall?: LinkOptions['stall'];
	timeout?: number;
	/** How long each device waits for a file to be quiet before it sends (`SEND_QUIET`); 0 for a test of exact interleavings. */
	quiet?: number;
	/** The server's limits, such as a small catch-up page so catch-ups come in several. */
	limits?: Partial<Limits>;
	/** Called with a line for every request, reply and notification. */
	trace?: (line: string) => void;
} = {}) {
	const net = createNet(seed);
	const requests: LinkOptions = {
		ordered: false,
		lossCloses: false,
		latency,
		loss: { ...loss },
		...(stall === undefined ? {} : { stall }),
	};
	const stream: LinkOptions = {
		ordered: false,
		lossCloses: true,
		latency,
		loss: { up: 0, down: streamLoss },
		...(stall === undefined ? {} : { stall }),
	};
	const commitHooks: ((committed: Committed) => void)[] = [];
	const requestHooks: ((
		device: string,
		request: Request,
		reply: Reply,
	) => void)[] = [];
	/** The repository's members: every device's person, and `mallory`, a member who writes straight to the server. */
	const members = new Set(['mallory']);
	const git = createMemoryGitStore();
	// The server flushes on its own schedule (quiet 60 s, at most every 5 minutes) on virtual time.
	const server = createServer({
		store: openBunSqlite(),
		git,
		clock: () => EPOCH + net.now(),
		alarm: virtualAlarm(net),
		...(limits === undefined ? {} : { limits }),
		onCommit: (committed) => commitHooks.forEach((hook) => hook(committed)),
	});
	const counts = { push: 0, 'catch-up': 0, fetch: 0, notifications: 0 };
	/** The session the host would verify for `user`: a writer if a member. */
	const session = (user: string): Session => ({
		user,
		role: members.has(user) ? 'writer' : null,
	});

	function device(name: string) {
		members.add(name);
		// The device's database: a restart opens a new replica over it; a lost device gets a new one.
		let driver = openBunSqlite();
		const make = () =>
			unwrap(
				openReplica({
					driver,
					binding: BINDING(name),
					device: name,
					after: net.after,
					now: () => EPOCH + net.now(),
					timeout,
					quiet,
				}),
			);
		let replica = make();
		let online = true;
		let link: ReturnType<typeof net.connect<Request, Reply>> | null = null;
		let notifications: ReturnType<typeof net.connect<never, Event>> | null =
			null;
		let reopening = false;

		function answer(request: Request): Reply {
			counts[request.type]++;
			switch (request.type) {
				case 'push': {
					const answer = server.push(request.commit, session(name));
					return { type: 'answer', rid: request.rid, answer };
				}
				case 'catch-up': {
					const catchUp = server.catchUp(request);
					return { type: 'caught-up', rid: request.rid, catchUp };
				}
				case 'fetch':
					return {
						type: 'fetched',
						rid: request.rid,
						texts: server.fetch(request.hashes),
					};
			}
		}

		function openRequests() {
			const current = net.connect<Request, Reply>(requests, {
				server: (request) => {
					const reply = answer(request);
					for (const hook of requestHooks) hook(name, request, reply);
					trace?.(
						`${net.now()} ${name} ${JSON.stringify(request)}\n    -> ${JSON.stringify(reply)}`,
					);
					current.down(reply);
				},
				client: (reply) => {
					trace?.(`${net.now()} ${name} receives reply ${reply.rid}`);
					replica.reply(reply);
				},
				closed: () => {},
			});
			link = current;
			replica.attach(current.up);
		}

		function openStream() {
			if (!online || notifications?.isOpen()) return;
			let unsubscribe: (() => void) | null = null;
			const current = net.connect<never, Event>(stream, {
				server: () => {},
				client: (event) => {
					counts.notifications++;
					trace?.(`${net.now()} ${name} notified ${JSON.stringify(event)}`);
					replica.notify(event);
				},
				closed: () => {
					if (notifications !== current) return;
					notifications = null;
					if (online) reopen();
				},
				serverClosed: () => unsubscribe?.(),
			});
			unsubscribe = server.subscribe((event) => current.down(event));
			notifications = current;
			// The stream's first exchange, as a socket's hello: a main other than the device's position means it may have missed something.
			unwrap(
				replica.hello({
					...BINDING(name),
					user: name,
					main: server.main(),
					limits: server.sizing(),
				}),
			);
		}

		function reopen() {
			if (reopening) return;
			reopening = true;
			net.after(net.random.int(10, 60), () => {
				reopening = false;
				if (!online) return;
				if (link === null) openRequests();
				openStream();
			});
		}

		/**
		 * A new replica gets new connections, as a reloaded page does: replies
		 * to the old one's requests die with its connection, so its request
		 * ids, which the new one may reuse, never answer the new one's.
		 */
		function reconnect() {
			if (!online) return;
			link?.close();
			link = null;
			notifications?.close();
			notifications = null;
			openRequests();
			openStream();
		}

		openRequests();
		openStream();

		return {
			name,
			get replica() {
				return replica;
			},
			/** The device's database, which a host keeps beside the replica (the folder engine's record). */
			get driver() {
				return driver;
			},
			isOnline: () => online,
			setOnline(next: boolean) {
				if (next === online) return;
				online = next;
				if (next) return reopen();
				link?.close();
				link = null;
				notifications?.close();
				notifications = null;
				replica.attach(null);
			},
			/** The reply to the next request this device sends is lost (the server still acts on it). */
			loseNextReply: () => link?.loseNextDown(),
			/** Drop the replica and open it again from its database. */
			restart() {
				replica.close();
				replica = make();
				reconnect();
			},
			/** The device's storage is gone for good: it comes back as a fresh replica that knows nothing. */
			lose() {
				replica.close();
				driver.close();
				driver = openBunSqlite();
				replica = make();
				reconnect();
			},
		};
	}

	return {
		net,
		server,
		device,
		/** LFS bytes reach the server (the upload track). */
		upload: (oid: string, size: number) => server.upload(oid, size),
		git,
		session,
		/** Flush live history into Git commits now (`epicenter pull`, `git fetch`); resolves when the flush does. */
		flush: () => server.flush(),
		/** Turn all loss and stalls off (the quiescence phase). */
		calm() {
			requests.loss = { up: 0, down: 0 };
			stream.loss = { up: 0, down: 0 };
			delete requests.stall;
			delete stream.stall;
		},
		onCommit: (hook: (committed: Committed) => void) => commitHooks.push(hook),
		/** Every request the server answered, with its reply. */
		onRequest: (
			hook: (device: string, request: Request, reply: Reply) => void,
		) => requestHooks.push(hook),
		counts: () => ({ ...counts, flushes: server.history().flushes }),
		/** Run until no event is left; false if it never went idle. */
		settle: (limit?: number) => net.runUntilIdle(limit),
	};
}

export type World = ReturnType<typeof createWorld>;
export type Device = ReturnType<World['device']>;
