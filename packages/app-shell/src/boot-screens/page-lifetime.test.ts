/** Departure orders producer drains and App closure, suppressing actions after retirement or teardown. */
import { expect, test } from 'bun:test';
import { createPageLifetime } from './page-lifetime.test-support.js';

function app(close: () => Promise<void> = async () => {}) {
	const controller = new AbortController();
	return {
		controller,
		signal: controller.signal,
		async close() {
			controller.abort();
			await close();
		},
	};
}

test('departure drains producers, closes storage, then changes authentication', async () => {
	const events: string[] = [];
	const departure = createPageLifetime({
		opening: Promise.resolve(
			app(async () => {
				events.push('close');
			}),
		),
		async stopUi() {
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
	const departure = createPageLifetime({
		opening: Promise.resolve(
			app(async () => {
				events.push('close');
				await gate.promise;
			}),
		),
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
	const opened = app();
	const departure = createPageLifetime({
		opening: Promise.resolve(opened),
		async preflight() {
			if (recording) throw Error('recording');
		},
	});
	await expect(departure.close()).rejects.toThrow('recording');
	expect(departure.state.phase).toBe('open');
	expect(opened.signal.aborted).toBe(false);
	recording = false;
	await departure.close();
	expect(departure.state.phase).toBe('closed');
});

for (const fails of ['drain', 'close', 'action']) {
	test(`${fails} failure is terminal and cannot change authentication or retry cleanup`, async () => {
		const events: string[] = [];
		const departure = createPageLifetime({
			opening: Promise.resolve(
				app(async () => {
					events.push('close');
					if (fails === 'close') throw Error(fails);
				}),
			),
			async stopUi() {
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

test('external retirement bypasses preflight and prevents departure actions', async () => {
	const opened = app();
	const events: string[] = [];
	const departure = createPageLifetime({
		opening: Promise.resolve(opened),
		async preflight() {
			throw Error('must bypass');
		},
		async stopUi() {
			events.push('drain');
		},
	});
	await Promise.resolve();
	opened.controller.abort();
	await departure.close();
	expect(events).toEqual(['drain']);
	expect(departure.state.phase).toBe('retired');
	await expect(
		departure.go(() => {
			events.push('auth');
		}),
	).rejects.toThrow('data');
	expect(events).toEqual(['drain']);
});

test('deliberate App closure is not mistaken for external retirement', async () => {
	const departure = createPageLifetime({ opening: Promise.resolve(app()) });
	let navigated = false;
	await departure.go(() => {
		navigated = true;
	});
	expect(navigated).toBe(true);
});

test('retirement during producer cleanup suppresses the pending authentication change', async () => {
	const opened = app();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const departure = createPageLifetime({
		opening: Promise.resolve(opened),
		async stopUi() {
			entered.resolve();
			await release.promise;
		},
	});
	let navigated = false;
	const pending = departure.go(() => {
		navigated = true;
	});
	await entered.promise;
	opened.controller.abort();
	release.resolve();
	await expect(pending).rejects.toThrow('data');
	expect(navigated).toBe(false);
});

test('failed opening rejects closure and prevents authentication changes', async () => {
	const opening = Promise.withResolvers<ReturnType<typeof app>>();
	const departure = createPageLifetime({ opening: opening.promise });
	let navigated = false;
	const pending = departure.go(() => {
		navigated = true;
	});
	const failure = Error('storage unavailable');
	opening.reject(failure);
	await expect(pending).rejects.toBe(failure);
	await expect(departure.close()).rejects.toBe(failure);
	expect(navigated).toBe(false);
});

test('abandon during a pending preflight bypasses its later veto and suppresses navigation', async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const opened = app();
	let navigated = false;
	const departure = createPageLifetime({
		opening: Promise.resolve(opened),
		async preflight() {
			entered.resolve();
			await release.promise;
			throw Error('veto');
		},
	});
	const pending = departure.go(() => {
		navigated = true;
	});
	await entered.promise;
	const abandoning = departure.abandon();
	await abandoning;
	release.resolve();
	await expect(pending).rejects.toThrow('page closed');
	expect(opened.signal.aborted).toBe(true);
	expect(navigated).toBe(false);
	expect(departure.state.phase).toBe('failed');
});

test('abandon during opening closes the eventual App without consulting preflight', async () => {
	const opening = Promise.withResolvers<ReturnType<typeof app>>();
	const departure = createPageLifetime({
		opening: opening.promise,
		async preflight() {
			throw Error('must bypass');
		},
	});
	const closing = departure.abandon();
	const opened = app();
	opening.resolve(opened);
	await closing;
	expect(opened.signal.aborted).toBe(true);
	await expect(
		departure.go(() => {
			throw Error('must not act');
		}),
	).rejects.toThrow('page closed');
});

for (const reason of ['data', 'account'] as const) {
	test(`${reason} retirement interrupts a confirmation that never answers`, async () => {
		const entered = Promise.withResolvers<void>();
		const veto = Promise.withResolvers<void>();
		const opened = app();
		const calls: string[] = [];
		let changed:
			| ((state: import('@epicenter/auth').AuthState) => void)
			| undefined;
		const account = {} as import('@epicenter/auth').Account;
		const lifetime = createPageLifetime({
			account,
			auth: {
				onStateChange(listener) {
					changed = listener;
					return () => {};
				},
			},
			opening: Promise.resolve(opened),
			async preflight() {
				entered.resolve();
				await veto.promise;
			},
			async stopUi(voluntary) {
				expect(voluntary).toBe(false);
				calls.push('drained');
			},
		});
		const leaving = lifetime.go(() => {
			calls.push('auth action');
		});
		const refused = leaving.catch((error: Error) => error);
		await entered.promise;
		if (reason === 'data') opened.controller.abort();
		else changed!({ status: 'signed-out' });
		await lifetime.close();
		expect((await refused)?.message).toContain(reason);
		expect(calls).toEqual(['drained']);
		expect(opened.signal.aborted).toBe(true);
		// A later rejection must be observed, without reopening or changing auth.
		veto.reject(Error('late veto'));
		await Promise.resolve();
		expect(calls).toEqual(['drained']);
	});
}
