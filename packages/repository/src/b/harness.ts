/**
 * Test support for design B: one server, a seeded network, and devices with
 * two channels each: requests (writes, catch-ups, reads by hash), each
 * delayed on its own, lost, or answered with a reply that is lost; and a
 * notification stream, delayed and reordered per message, which a lost
 * message closes and which reopens and resumes by catching up. Devices go
 * offline and restart from what they persisted.
 */
import { createNet, type LinkOptions } from './net.js';
import { createMemoryStore, createReplica, type MergeAudit, type Reply, type Request } from './replica.js';
import { type Applied, createServer, type Event } from './server.js';

export function createWorld({
	seed = 1,
	latency = { min: 5, max: 40 },
	loss = { up: 0, down: 0 },
	streamLoss = 0,
	timeout = 2_000,
	trace,
}: {
	seed?: number;
	latency?: LinkOptions['latency'];
	/** Chance a request, or its reply, is lost. */
	loss?: LinkOptions['loss'];
	/** Chance a notification is lost (closing the stream). */
	streamLoss?: number;
	timeout?: number;
	/** Called with a line for every request, reply and notification. */
	trace?: (line: string) => void;
} = {}) {
	const net = createNet(seed);
	const requests: LinkOptions = { ordered: false, lossCloses: false, latency, loss: { ...loss } };
	const stream: LinkOptions = { ordered: false, lossCloses: true, latency, loss: { up: 0, down: streamLoss } };
	const appliedHooks: ((applied: Applied) => void)[] = [];
	const mergeHooks: ((audit: MergeAudit & { device: string }) => void)[] = [];
	const server = createServer({ onApplied: (applied) => appliedHooks.forEach((hook) => hook(applied)) });
	const counts = { write: 0, 'catch-up': 0, fetch: 0, compared: 0, notifications: 0 };

	function device(name: string, { mode = 'person' as 'person' | 'agent' } = {}) {
		const store = createMemoryStore();
		const make = () =>
			createReplica({
				device: name,
				mode,
				store,
				after: net.after,
				timeout,
				onMerge: (audit) => mergeHooks.forEach((hook) => hook({ ...audit, device: name })),
			});
		let replica = make();
		let online = true;
		let link: ReturnType<typeof net.connect<Request, Reply>> | null = null;
		let notifications: ReturnType<typeof net.connect<never, Event>> | null = null;
		let reopening = false;

		function answer(request: Request): Reply {
			const reply = respond(request);
			trace?.(`${net.now()} ${name} ${JSON.stringify(request)}\n    -> ${JSON.stringify(reply)}`);
			return reply;
		}
		function respond(request: Request): Reply {
			counts[request.type]++;
			switch (request.type) {
				case 'write':
					return { type: 'answer', rid: request.rid, answer: server.write(name, request.files) };
				case 'catch-up': {
					const catchUp = server.catchUp(request);
					counts.compared += catchUp.compared;
					return { type: 'caught-up', rid: request.rid, catchUp };
				}
				case 'fetch':
					return { type: 'fetched', rid: request.rid, texts: server.fetch(request.hashes) };
			}
		}

		function openRequests() {
			const current = net.connect<Request, Reply>(requests, {
				server: (request) => current.down(answer(request)),
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
			replica.streamOpened();
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

		openRequests();
		openStream();

		return {
			name,
			get replica() {
				return replica;
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
			/** Drop the replica and build it again from what it persisted. */
			restart() {
				replica.close();
				replica = make();
				if (link !== null) replica.attach(link.up);
			},
			storeBytes: () => store.bytes(),
		};
	}

	return {
		net,
		server,
		device,
		/** Turn all loss off (the quiescence phase). */
		calm() {
			requests.loss = { up: 0, down: 0 };
			stream.loss = { up: 0, down: 0 };
		},
		onApplied: (hook: (applied: Applied) => void) => appliedHooks.push(hook),
		onMerge: (hook: (audit: MergeAudit & { device: string }) => void) => mergeHooks.push(hook),
		counts: () => ({ ...counts }),
		/** Run until no event is left; false if it never went idle. */
		settle: (limit?: number) => net.runUntilIdle(limit),
	};
}

export type World = ReturnType<typeof createWorld>;
export type Device = ReturnType<World['device']>;
