/**
 * Page departure preserves close-before-selection and never reopens a closed App.
 * Tests cover delayed writes, competing actions, reversible preflight refusal,
 * terminal failures, and unexpected Account retirement.
 */
import { expect, test } from 'bun:test';
import type { Account, AuthClient, AuthState } from '@epicenter/auth';
import { createDeparture } from './departure.js';

function setup(close: () => Promise<void> = async () => {}) {
	let observer: (state: AuthState) => void = () => {};
	const auth = {
		onStateChange(listener: typeof observer) {
			observer = listener;
			return () => {
				observer = () => {};
			};
		},
	} satisfies Pick<AuthClient, 'onStateChange'>;
	const account: Account = {
		authorityId: 'test',
		principalId: 'alice' as Account['principalId'],
		baseURL: 'https://example.test',
		async fetch() {
			return new Response();
		},
		async openWebSocket() {
			throw new Error('Unused');
		},
		async getProfile() {
			throw new Error('Unused');
		},
	};
	const departure = createDeparture({ auth, account, close });
	return {
		departure,
		retire: () => observer({ status: 'signed-out' }),
		refresh: () => observer({ status: 'reauth-required', account }),
	};
}

test('same-Account credential refusal keeps the page open', async () => {
	let closed = false;
	const { departure, refresh } = setup(async () => {
		closed = true;
	});
	refresh();
	await Bun.sleep(0);
	expect(departure.state.phase).toBe('open');
	expect(closed).toBe(false);
	await departure.close();
});

test('final UI write and physical close settle before the first chosen action', async () => {
	const released = Promise.withResolvers<void>();
	const events: string[] = [];
	const { departure } = setup(async () => {
		events.push('close');
		await released.promise;
		events.push('released');
	});
	departure.attachUi({
		async quiesce() {
			events.push('last edit');
		},
	});
	const first = departure.go(() => {
		events.push('account A');
	});
	const second = departure.go(() => {
		events.push('account B');
	});
	expect(second).toBe(first);
	await Bun.sleep(0);
	expect(events).toEqual(['last edit', 'close']);
	released.resolve();
	await first;
	expect(events).toEqual(['last edit', 'close', 'released', 'account A']);
});

test('a preflight refusal leaves the page usable and permits retry', async () => {
	let recording = true;
	let selected = false;
	const { departure } = setup();
	departure.attachUi({
		async preflight() {
			if (recording) throw new Error('Finish recording');
		},
		async quiesce() {},
	});
	await expect(
		departure.go(() => {
			selected = true;
		}),
	).rejects.toThrow('Finish recording');
	expect(departure.state.phase).toBe('open');
	expect(selected).toBe(false);
	recording = false;
	await departure.go(() => {
		selected = true;
	});
	expect(selected).toBe(true);
});

test('physical close failure prevents selection and remains terminal', async () => {
	let closes = 0;
	let selected = false;
	const { departure } = setup(async () => {
		closes++;
		throw new Error('disk failed');
	});
	await expect(
		departure.go(() => {
			selected = true;
		}),
	).rejects.toThrow('disk failed');
	await expect(
		departure.go(() => {
			selected = true;
		}),
	).rejects.toThrow('disk failed');
	expect(departure.state.phase).toBe('failed');
	expect(closes).toBe(1);
	expect(departure.canReopen).toBe(false);
	expect(selected).toBe(false);
});

test('quiescence failure still releases storage and prevents selection', async () => {
	let closed = false;
	let selected = false;
	const { departure } = setup(async () => {
		closed = true;
	});
	departure.attachUi({
		async quiesce() {
			throw new Error('final write failed');
		},
	});
	await expect(
		departure.go(() => {
			selected = true;
		}),
	).rejects.toThrow('final write failed');
	expect(closed).toBe(true);
	expect(selected).toBe(false);
	expect(departure.state.phase).toBe('failed');
	expect(departure.canReopen).toBe(false);
});

test('selection failure after close cannot trigger another action', async () => {
	const { departure } = setup();
	let second = false;
	await expect(
		departure.go(() => {
			throw new Error('login failed');
		}),
	).rejects.toThrow('login failed');
	await expect(
		departure.go(() => {
			second = true;
		}),
	).rejects.toThrow('login failed');
	expect(second).toBe(false);
	expect(departure.canReopen).toBe(true);
});

test('unexpected retirement bypasses voluntary preflight and closes locally', async () => {
	let closed = false;
	const { departure, retire } = setup(async () => {
		closed = true;
	});
	departure.attachUi({
		async preflight() {
			throw new Error('recording');
		},
		async quiesce() {},
	});
	retire();
	await departure.close();
	expect(closed).toBe(true);
	expect(departure.state.phase).toBe('retired');
	await expect(departure.go(() => {})).rejects.toThrow('account changed');
});

test('native close can acknowledge during a departure action without waiting for that action', async () => {
	const { departure } = setup();
	let acknowledged = false;
	await departure.go(async () => {
		await departure.close();
		acknowledged = true;
	});
	expect(acknowledged).toBe(true);
});

test('retirement during preflight closes despite refusal and suppresses the selected action', async () => {
	const checked = Promise.withResolvers<void>();
	let closed = false;
	let selected = false;
	const { departure, retire } = setup(async () => {
		closed = true;
	});
	departure.attachUi({ preflight: () => checked.promise, async quiesce() {} });
	const pending = departure.go(() => {
		selected = true;
	});
	await Bun.sleep(0);
	retire();
	checked.reject(new Error('Finish recording'));
	await expect(pending).rejects.toThrow('account changed');
	expect(closed).toBe(true);
	expect(selected).toBe(false);
});

test('completed resource close remains noninteractive while the action is pending', async () => {
	const selected = Promise.withResolvers<void>();
	const { departure } = setup();
	const pending = departure.go(() => selected.promise);
	await Bun.sleep(0);
	expect(departure.state.phase).toBe('departing');
	selected.resolve();
	await pending;
	expect(departure.state.phase).toBe('departing');
});

test('library retirement quiesces UI and waits invalidation before close and reload', async () => {
	const notification =
		Promise.withResolvers<import('@epicenter/data/store').LibraryRetirement>();
	const invalidation = Promise.withResolvers<void>();
	const events: string[] = [];
	const departure = createDeparture({
		account: null,
		retirement: notification.promise,
		close: async () => {
			events.push('close');
		},
		reload: () => {
			events.push('reload');
		},
	});
	departure.attachUi({
		async preflight() {
			throw new Error('Retirement must bypass preflight');
		},
		async quiesce() {
			events.push('quiesce');
		},
	});
	notification.resolve({
		invalidated: invalidation.promise,
		retryInvalidation: () => invalidation.promise,
	});
	await Bun.sleep(0);
	expect(events).toEqual(['quiesce']);
	const closed = departure.close();
	invalidation.resolve();
	await closed;
	expect(events).toEqual(['quiesce', 'close', 'reload']);
	await departure.close();
	expect(events).toHaveLength(3);
});

test('failed library invalidation retains ownership and retries cleanup without another UI drain', async () => {
	const notification =
		Promise.withResolvers<import('@epicenter/data/store').LibraryRetirement>();
	const first = Promise.withResolvers<void>();
	const retry = Promise.withResolvers<void>();
	let closes = 0;
	let quiesces = 0;
	let reloads = 0;
	const departure = createDeparture({
		account: null,
		retirement: notification.promise,
		close: async () => {
			closes += 1;
		},
		reload: () => {
			reloads += 1;
		},
	});
	departure.attachUi({
		async quiesce() {
			quiesces += 1;
		},
	});
	notification.resolve({
		invalidated: first.promise,
		retryInvalidation: () => retry.promise,
	});
	await Bun.sleep(0);
	first.reject(new Error('Disk failed'));
	await expect(departure.close()).rejects.toThrow('Disk failed');
	expect(closes).toBe(0);
	expect(departure.canRetryRetirement).toBe(true);
	const finishing = departure.retryRetirement();
	retry.resolve();
	await finishing;
	expect(quiesces).toBe(1);
	expect(closes).toBe(1);
	expect(reloads).toBe(1);
});

test('a retirement UI cleanup failure keeps the claim held and permits retry', async () => {
	const notification =
		Promise.withResolvers<import('@epicenter/data/store').LibraryRetirement>();
	let busy = true;
	let closed = false;
	const departure = createDeparture({
		account: null,
		retirement: notification.promise,
		close: async () => {
			closed = true;
		},
		reload() {},
	});
	departure.attachUi({
		async quiesce() {
			if (busy) throw new Error('Producer still running');
		},
	});
	notification.resolve({
		invalidated: Promise.resolve(),
		retryInvalidation: () => Promise.resolve(),
	});
	await Bun.sleep(0);
	await expect(departure.close()).rejects.toThrow('Producer still running');
	expect(closed).toBe(false);
	expect(departure.canReopen).toBe(false);
	busy = false;
	await departure.retryRetirement();
	expect(closed).toBe(true);
});

test('retirement during voluntary UI drain takes over close ordering and suppresses auth changes', async () => {
	const notification =
		Promise.withResolvers<import('@epicenter/data/store').LibraryRetirement>();
	const draining = Promise.withResolvers<void>();
	const invalidating = Promise.withResolvers<void>();
	let closed = false;
	let selected = false;
	const departure = createDeparture({
		account: null,
		retirement: notification.promise,
		close: async () => {
			closed = true;
		},
		reload() {},
	});
	departure.attachUi({ quiesce: () => draining.promise });
	const going = departure.go(() => {
		selected = true;
	});
	const refusal = going.catch((error: unknown) => error);
	await Bun.sleep(0);
	notification.resolve({
		invalidated: invalidating.promise,
		retryInvalidation: () => invalidating.promise,
	});
	draining.resolve();
	await Bun.sleep(0);
	expect(closed).toBe(false);
	invalidating.resolve();
	expect(await refusal).toEqual(
		new Error('The library was restored. Reload the application.'),
	);
	expect(closed).toBe(true);
	expect(selected).toBe(false);
});
