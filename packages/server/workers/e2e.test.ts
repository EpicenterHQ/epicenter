/**
 * Two signed-in devices, one account, one note crossing between them.
 *
 * The claim the whole store transport exists to make, asserted against the
 * DEPLOYED route and the DEPLOYED Durable Object inside real `workerd`. The one
 * substitution is the bearer resolver; Better Auth is tested elsewhere and is
 * not what this adds.
 *
 * ## The controls
 *
 * Convergence is asserted on the RECEIVING replica's own rows, read back
 * through its workspace out of its own SQLite, never on a count this file kept. A
 * rule on this branch once "worked" in a simulation that delivered nothing.
 *
 * And the isolation that gives the claim its meaning: a device on a DIFFERENT
 * principal must see nothing. Without it, "the note arrived" is also what a
 * single shared authority looks like, which would be a data leak rather than a
 * feature.
 */

import { env, runInDurableObject, SELF } from 'cloudflare:test';
import {
	bearerSubprotocol,
	formatSubprotocols,
	MAIN_SUBPROTOCOL,
} from '@epicenter/sync';
import { describe, expect, it } from 'vitest';

import type { ReplicaReport, StoreTestReplica } from './replica.js';

const ORIGIN = 'http://example.com';

type Replicas = ReturnType<typeof openAccount>;

function openAccount(label: string) {
	const account = `${label}-${crypto.randomUUID()}`;
	return {
		account,
		/**
		 * One device of this account, or of another when `principal` says so.
		 *
		 * Personal uses the resolved actor; Shared joins the application's library.
		 */
		device(name: string, principal = account) {
			const stub = env.REPLICA.get(
				env.REPLICA.idFromName(`${account}-${name}`),
			);
			// `runInDurableObject` widens the instance to the base `DurableObject`,
			// so the concrete class is named here rather than reached for through
			// the stub's own generic.
			const inside = <TValue>(
				run: (replica: StoreTestReplica) => TValue,
			): Promise<TValue> =>
				runInDurableObject(stub, (replica) =>
					run(replica as unknown as StoreTestReplica),
				);
			return {
				open: (options?: {
					connect?: boolean;
					library?: 'personal' | 'shared';
				}) =>
					inside((replica) =>
						replica.open(`device:${principal}`, ORIGIN, options),
					),
				startSync: () => inside((replica) => replica.startSync()),
				stopSync: () => inside((replica) => replica.stopSync()),
				write: (title: string, text: string) =>
					inside((replica) => replica.write(title, text)),
				remove: (title: string) => inside((replica) => replica.remove(title)),
				report: (): Promise<ReplicaReport> =>
					inside((replica) => replica.report()).then((made) => made),
			};
		},
	};
}

/** Wait until the production driver reports its socket connection. */
async function bound(device: {
	report(): Promise<ReplicaReport>;
}): Promise<void> {
	await until(
		'the device to connect to its authority',
		async () => (await device.report()).connected,
	);
}

/** Poll until `check` holds, or fail loudly rather than hang. */
async function until(
	label: string,
	check: () => Promise<boolean>,
	timeoutMs = 15_000,
): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		if (await check()) return;
		if (Date.now() > deadline)
			throw new Error(`timed out waiting for ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}

describe('two devices on one account converge', () => {
	it('a note written on the phone arrives on the laptop, with its text', async () => {
		const vault: Replicas = openAccount('converge');
		const phone = vault.device('phone');
		const laptop = vault.device('laptop');
		await phone.open();
		await laptop.open();
		await bound(phone);

		await phone.write('Groceries', 'milk and eggs');

		await until('the laptop to hold the note', async () => {
			const report = await laptop.report();
			return report.titles.includes('Groceries');
		});

		const arrived = await laptop.report();
		expect(arrived.titles).toEqual(['Groceries']);
		expect(arrived.text.join(' ')).toContain('milk and eggs');
		expect(arrived.lastError).toBeUndefined();
	});

	it('CONTROL: a device on another account sees nothing', async () => {
		// The isolation that makes the test above a feature rather than a leak.
		// Same route, same worker, same Durable Object class; only the bearer
		// differs, and the authority is addressed by the principal it resolves to.
		const vault = openAccount('isolation');
		const mine = vault.device('mine');
		const stranger = vault.device(
			'stranger',
			`someone-else-${crypto.randomUUID()}`,
		);
		await mine.open();
		await stranger.open();
		await bound(mine);

		await mine.write('Private', 'not for you');
		await until('my own device to hold it', async () =>
			(await mine.report()).titles.includes('Private'),
		);
		// Long enough that a leak would have arrived: the writer's own copy has
		// already round-tripped through the authority by now.
		await new Promise((resolve) => setTimeout(resolve, 500));

		expect((await stranger.report()).titles).toEqual([]);
	});

	it('both directions, and a third device catches up on arrival', async () => {
		const vault = openAccount('catchup');
		const phone = vault.device('phone');
		const laptop = vault.device('laptop');
		await phone.open();
		await laptop.open();
		await bound(phone);
		await bound(laptop);

		await phone.write('from the phone', 'one');
		await laptop.write('from the laptop', 'two');
		await until('both devices to hold both notes', async () => {
			const [a, b] = await Promise.all([phone.report(), laptop.report()]);
			return a.titles.length === 2 && b.titles.length === 2;
		});

		// A device that was never connected while any of that happened gets it all
		// from the authority's log when it first dials, which is the same catch-up
		// a returning device runs.
		const tablet = vault.device('tablet');
		await tablet.open();
		await until(
			'the tablet to catch up',
			async () => (await tablet.report()).titles.length === 2,
		);

		expect((await tablet.report()).titles).toEqual([
			'from the laptop',
			'from the phone',
		]);
	});

	it('an upgrade with no bearer is refused', async () => {
		const response = await SELF.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?dataId=so.epicenter.storeprobe&cursor=0`,
				{
					headers: { Upgrade: 'websocket' },
				},
			),
		);
		expect(response.status).toBe(401);
	});

	it('a dataId no workspace could declare is refused', async () => {
		const response = await SELF.fetch(
			new Request(
				`${ORIGIN}/api/store/v1/sync?appId=so.epicenter.storeprobe&library=personal&dataId=../escape&generation=1&cursor=0`,
				{
					headers: {
						Upgrade: 'websocket',
						'sec-websocket-protocol': formatSubprotocols([
							MAIN_SUBPROTOCOL,
							bearerSubprotocol('device:someone'),
						]),
					},
				},
			),
		);
		expect(response.status).toBe(403);
	});
});

it('Alice and Bob converge on Shared rows while their Personal rows remain separate', async () => {
	const vault = openAccount('shared');
	const alice = vault.device('alice-shared', 'alice');
	const bob = vault.device('bob-shared', 'bob');
	const personal = vault.device('alice-personal', 'alice');
	await Promise.all([
		alice.open({ library: 'shared' }),
		bob.open({ library: 'shared' }),
		personal.open(),
	]);
	await bound(alice);
	await bound(bob);
	await bound(personal);
	const title = `Shared ${crypto.randomUUID()}`;
	await alice.write(title, 'Both people can read this');
	await until('Bob to receive the Shared row', async () =>
		(await bob.report()).titles.includes(title),
	);
	expect((await bob.report()).text.join(' ')).toContain(
		'Both people can read this',
	);
	expect((await personal.report()).titles).not.toContain(title);
});
