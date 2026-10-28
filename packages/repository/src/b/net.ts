/**
 * A deterministic network for design B's tests: virtual time, seeded
 * randomness, and connections that delay, drop, reorder or lose messages.
 *
 * A connection may keep messages in order or give each its own delay, so
 * they arrive in any order; a lost message either closes the connection
 * (a stream, which then loses everything in flight) or is just gone (a
 * request or its reply).
 */

/** A small seeded generator (mulberry32). */
export function createRandom(seed: number) {
	let state = seed >>> 0;
	const next = () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
	return {
		next,
		/** An integer in [min, max]. */
		int: (min: number, max: number) => min + Math.floor(next() * (max - min + 1)),
		chance: (p: number) => next() < p,
		pick: <T>(items: readonly T[]): T => {
			const item = items[Math.floor(next() * items.length)];
			if (item === undefined) throw new Error('pick from an empty list');
			return item;
		},
	};
}

export type Random = ReturnType<typeof createRandom>;

export type LinkOptions = {
	/** Messages arrive in the order sent. */
	ordered: boolean;
	/** Losing a message closes the connection (a stream), instead of losing only that message (a request). */
	lossCloses: boolean;
	/** One-way delay range in milliseconds. */
	latency: { min: number; max: number };
	/** Chance each message up (client to server) or down is lost. */
	loss: { up: number; down: number };
	/** Chance a message stalls, and for how long beyond its latency (a slow request, a reply after its timeout). */
	stall?: { chance: number; ms: number };
};

type Event = { at: number; order: number; run: () => void };

export function createNet(seed: number) {
	const random = createRandom(seed);
	const heap: Event[] = [];
	let now = 0;
	let order = 0;
	let nextConnection = 1;

	const less = (a: Event, b: Event) => a.at < b.at || (a.at === b.at && a.order < b.order);
	function push(event: Event) {
		heap.push(event);
		let i = heap.length - 1;
		while (i > 0) {
			const parent = (i - 1) >> 1;
			const [x, y] = [heap[i] as Event, heap[parent] as Event];
			if (!less(x, y)) break;
			heap[i] = y;
			heap[parent] = x;
			i = parent;
		}
	}
	function pop(): Event | undefined {
		const top = heap[0];
		const last = heap.pop();
		if (heap.length > 0 && last !== undefined) {
			heap[0] = last;
			let i = 0;
			for (;;) {
				const l = 2 * i + 1;
				const r = l + 1;
				let m = i;
				if (l < heap.length && less(heap[l] as Event, heap[m] as Event)) m = l;
				if (r < heap.length && less(heap[r] as Event, heap[m] as Event)) m = r;
				if (m === i) break;
				[heap[i], heap[m]] = [heap[m] as Event, heap[i] as Event];
				i = m;
			}
		}
		return top;
	}

	const at = (time: number, run: () => void) => push({ at: Math.max(time, now), order: order++, run });

	/**
	 * Open a connection. `server` receives messages sent up, `client` those
	 * sent down; `closed` tells the client the connection is gone.
	 */
	function connect<TUp, TDown>(
		options: LinkOptions,
		ends: { server: (message: TUp) => void; client: (message: TDown) => void; closed: () => void; serverClosed?: () => void },
	) {
		const id = nextConnection++;
		let open = true;
		let loseNextDown = false;
		let lastUp = 0;
		let lastDown = 0;
		const delay = () => random.int(options.latency.min, options.latency.max);
		const close = () => {
			if (!open) return;
			open = false;
			ends.serverClosed?.();
			at(now + delay(), ends.closed);
		};
		const deliver = <T>(message: T, lost: boolean, direction: 'up' | 'down', to: (message: T) => void) => {
			if (!open) return;
			if (lost) {
				if (options.lossCloses) close();
				return;
			}
			const copy = structuredClone(message);
			let time = now + delay();
			if (options.stall !== undefined && random.chance(options.stall.chance)) time += random.int(0, options.stall.ms);
			if (options.ordered) {
				time = Math.max(time, direction === 'up' ? lastUp : lastDown);
				if (direction === 'up') lastUp = time;
				else lastDown = time;
			}
			at(time, () => {
				if (open) to(copy);
			});
		};
		return {
			id,
			isOpen: () => open,
			up: (message: TUp) => deliver(message, random.chance(options.loss.up), 'up', ends.server),
			down: (message: TDown) => {
				const lost = loseNextDown || random.chance(options.loss.down);
				loseNextDown = false;
				deliver(message, lost, 'down', ends.client);
			},
			/** The next message down is lost (a reply lost after the server acted). */
			loseNextDown: () => {
				loseNextDown = true;
			},
			close,
		};
	}

	return {
		random,
		now: () => now,
		after: (ms: number, run: () => void) => at(now + ms, run),
		/** Run events until `ms` of virtual time pass. */
		runFor(ms: number) {
			const end = now + ms;
			while (heap.length > 0 && (heap[0] as Event).at <= end) {
				const event = pop() as Event;
				now = event.at;
				event.run();
			}
			now = end;
		},
		/** Run until no event is left, or `limit` events ran; returns whether it went idle. */
		runUntilIdle(limit = 1_000_000) {
			for (let n = 0; n < limit; n++) {
				const event = pop();
				if (event === undefined) return true;
				now = event.at;
				event.run();
			}
			return false;
		},
		pending: () => heap.length,
		connect,
	};
}

export type Net = ReturnType<typeof createNet>;
