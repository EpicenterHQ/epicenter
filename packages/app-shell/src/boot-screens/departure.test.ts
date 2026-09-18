import { expect, test } from 'bun:test';
import { createDeparture } from './departure.js';

test('departure drains producers, closes storage, then changes authentication', async () => {
	const events: string[] = [];
	const departure = createDeparture({
		async beforeClose() {
			events.push('close');
		},
	});
	departure.attachUi({
		async quiesce() {
			events.push('drain');
		},
	});
	await departure.go(() => {
		events.push('auth');
	});
	expect(events).toEqual(['drain', 'close', 'auth']);
});

test('concurrent departures share one cleanup and the first action', async () => {
	const gate = Promise.withResolvers<void>();
	const events: string[] = [];
	const departure = createDeparture({
		async beforeClose() {
			events.push('close');
			await gate.promise;
		},
	});
	const first = departure.go(() => {
		events.push('first');
	});
	const second = departure.go(() => {
		events.push('second');
	});
	expect(second).toBe(first);
	gate.resolve();
	await first;
	expect(events).toEqual(['close', 'first']);
});

test('preflight veto leaves an untouched lifetime usable', async () => {
	let recording = true;
	const departure = createDeparture({ async beforeClose() {} });
	departure.attachUi({
		async preflight() {
			if (recording) throw Error('recording');
		},
		async quiesce() {},
	});
	await expect(departure.close()).rejects.toThrow('recording');
	expect(departure.state.phase).toBe('open');
	recording = false;
	await departure.close();
	expect(departure.state.phase).toBe('closed');
});

for (const fails of ['drain', 'close', 'action']) {
	test(`${fails} failure is terminal and cannot mutate authentication or retry cleanup`, async () => {
		const events: string[] = [];
		const departure = createDeparture({
			async beforeClose() {
				events.push('close');
				if (fails === 'close') throw Error(fails);
			},
		});
		departure.attachUi({
			async quiesce() {
				events.push('drain');
				if (fails === 'drain') throw Error(fails);
			},
		});
		await expect(
			departure.go(() => {
				events.push('action');
				throw Error('action');
			}),
		).rejects.toThrow(fails);
		const recorded = [...events];
		await expect(
			departure.go(() => {
				events.push('second action');
			}),
		).rejects.toThrow(fails);
		expect(events).toEqual(recorded);
		expect(departure.state.phase).toBe('failed');
	});
}

test('external signal retirement drains locally and prevents departure actions', async () => {
	const controller = new AbortController();
	const events: string[] = [];
	const departure = createDeparture({
		opening: Promise.resolve({
			signal: controller.signal,
			async close() {
				controller.abort();
			},
		}),
		async beforeClose() {
			events.push('close');
		},
	});
	departure.attachUi({
		async preflight() {
			throw Error('must bypass');
		},
		async quiesce() {
			events.push('drain');
		},
	});
	await Promise.resolve();
	controller.abort();
	await departure.close();
	expect(events).toEqual(['drain', 'close']);
	expect(departure.state.phase).toBe('retired');
	await expect(
		departure.go(() => {
			events.push('auth');
		}),
	).rejects.toThrow('data');
	expect(events).toEqual(['drain', 'close']);
});

test('normal App signal abortion does not mistake deliberate close for retirement', async () => {
	const controller = new AbortController();
	const departure = createDeparture({
		opening: Promise.resolve({
			signal: controller.signal,
			async close() {
				controller.abort();
			},
		}),
		async beforeClose() {},
	});
	await Promise.resolve();
	let navigated = false;
	await departure.go(() => {
		navigated = true;
	});
	expect(navigated).toBe(true);
});

test('retirement during UI drain suppresses the pending authentication change', async () => {
	const controller = new AbortController();
	const gate = Promise.withResolvers<void>();
	const departure = createDeparture({
		opening: Promise.resolve({
			signal: controller.signal,
			async close() {
				controller.abort();
			},
		}),
		async beforeClose() {},
	});
	departure.attachUi({ quiesce: () => gate.promise });
	let navigated = false;
	const pending = departure.go(() => {
		navigated = true;
	});
	await Promise.resolve();
	await Promise.resolve();
	controller.abort();
	gate.resolve();
	await expect(pending).rejects.toThrow('data');
	expect(navigated).toBe(false);
});

test('opening failure is displayed without a replacement opening', async () => {
	const failure = Error('storage unavailable');
	const opening = Promise.reject(failure);
	const departure = createDeparture({
		opening,
		async beforeClose() {
			await opening;
		},
	});
	await Promise.resolve();
	expect(departure.state).toEqual({ phase: 'opening-failed', error: failure });
	await expect(departure.close()).rejects.toThrow('storage unavailable');
});

test('retirement while page resource cleanup waits prevents authentication mutation', async () => {
	const controller = new AbortController();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let changedAuth = false;
	const departure = createDeparture({
		opening: Promise.resolve({
			signal: controller.signal,
			async close() {
				controller.abort();
			},
		}),
		async beforeClose() {
			entered.resolve();
			await release.promise;
		},
	});
	const pending = departure.go(() => {
		changedAuth = true;
	});
	void pending.catch(() => {});
	await entered.promise;
	controller.abort();
	release.resolve();
	await expect(pending).rejects.toThrow('data');
	expect(changedAuth).toBe(false);
});

test('opening failure during departure retains the opening failure screen', async () => {
	const opening = Promise.withResolvers<{
		signal: AbortSignal;
		close(): Promise<void>;
	}>();
	const entered = Promise.withResolvers<void>();
	const departure = createDeparture({
		opening: opening.promise,
		beforeClose() {
			entered.resolve();
		},
	});
	const leaving = departure.go(() => {
		throw new Error('Must not navigate');
	});
	void leaving.catch(() => {});
	await entered.promise;
	const failure = new Error('Opening failed');
	opening.reject(failure);
	await expect(leaving).rejects.toBe(failure);
	expect(departure.state).toEqual({ phase: 'opening-failed', error: failure });
});

test('a preflight awaiting failed opening cannot restore an open departure', async () => {
	const opening = Promise.withResolvers<{
		signal: AbortSignal;
		close(): Promise<void>;
	}>();
	const entered = Promise.withResolvers<void>();
	const departure = createDeparture({ opening: opening.promise });
	departure.attachUi({
		async preflight() {
			entered.resolve();
			await opening.promise;
		},
		async quiesce() {
			throw new Error('Must not quiesce an unopened page');
		},
	});
	const leaving = departure.go(() => {
		throw new Error('Must not navigate');
	});
	void leaving.catch(() => {});
	await entered.promise;
	const failure = new Error('Opening failed');
	opening.reject(failure);
	await expect(leaving).rejects.toBe(failure);
	expect(departure.state).toEqual({ phase: 'opening-failed', error: failure });
	await expect(departure.close()).rejects.toBe(failure);
});
