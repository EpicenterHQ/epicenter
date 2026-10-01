/**
 * A Durable Object is really evicted, its sockets really survive, and the
 * test peers on the other end really converge.
 *
 * The wake path in `worker/index.ts` is the only code on this branch that had
 * never executed. It cannot be reached from `wrangler dev`, which will not evict
 * on demand, and reaching it against deployed Cloudflare means waiting on an
 * eviction timer nobody controls. `@cloudflare/vitest-pool-workers` exposes
 * `evictDurableObject`, which tears the instance down while HIBERNATING its
 * WebSockets rather than closing them, which is exactly the transition.
 *
 * ## The control every test here carries
 *
 * `stat().incarnation` is minted once per constructor. A hibernation test that
 * silently failed to evict would satisfy every convergence assertion below while
 * testing nothing at all, so each test reads the incarnation across its
 * eviction and requires it to have CHANGED, and a paired control runs the same
 * traffic without an eviction and requires it to be the SAME. Without the second
 * half, "it changed" is also what a per-call random value looks like.
 *
 * Convergence is asserted on the receiving test peer's own rows, read back
 * through the Workspace out of its own SQLite, never on a count the test kept.
 * The peer runs the real Store and sync client, but it is not a browser-storage
 * simulation: browser persistence is covered separately in `packages/app/src/data`.
 * The only numbers this file keeps are re-delivery observations, because a run
 * that re-sent nothing and a run that re-sent and was correctly ignored converge
 * identically.
 */
import { env, evictDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { TestPeerReport } from './test-peer.js';

/** A partition and two devices nobody else in this file shares. */
function openLab(label: string) {
	const partition = `${label}-${crypto.randomUUID()}`;
	return {
		partition,
		authority: env.SYNC.get(env.SYNC.idFromName(partition)),
		peer: (name: string) =>
			env.TEST_PEER.get(env.TEST_PEER.idFromName(`${partition}-${name}`)),
	};
}

/**
 * Wait for something the runtime does on its own schedule.
 *
 * Frames cross real sockets here, so nothing is settled by returning from a
 * call. The deadline is what turns "it never arrived" into a failure rather than
 * into a hang.
 */
async function settle(
	what: string,
	holds: () => Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + 15_000;
	for (;;) {
		if (await holds()) return;
		if (Date.now() > deadline) throw new Error(`never settled: ${what}`);
		await scheduler.wait(20);
	}
}

/**
 * A test peer is quiet when it holds what it should and reports nothing wrong.
 *
 * `inFlight` is in here because of what it caught. A woken object that had
 * rebuilt its socket map but not its hub took pushes and discarded them without
 * an ack and without a refusal, and the only symptom anywhere in the system was
 * a peer that owed work forever while every layer reported success.
 */
function expectHealthy(report: TestPeerReport, titles: string[]): void {
	expect(report.lastError).toBeUndefined();
	expect(report.lastErrorMessage).toBeUndefined();
	expect(report.needsResync).toBe(false);
	expect(report.unresolvedDependencies).toBe(false);
	expect(report.inFlight).toBe(false);
	expect(report.titles).toEqual([...titles].sort());
}

describe('a socket survives a wake and keeps syncing', () => {
	it('the object is evicted, and the other device still receives what it missed', async () => {
		const lab = openLab('survives');
		const phone = lab.peer('phone');
		const laptop = lab.peer('laptop');
		await phone.openSocket(lab.partition);
		await laptop.openSocket(lab.partition);

		phone.write('before the wake');
		await settle('the laptop holds the first row', async () =>
			(await laptop.report()).titles.includes('before the wake'),
		);
		const before = (await lab.authority.stat()).incarnation;

		// Both sockets hibernate rather than close, which is the whole point.
		await evictDurableObject(lab.authority);

		// The wake is caused by a frame on a hibernated socket, not by this test
		// calling the object: nothing touches the authority between the eviction
		// and this push.
		phone.write('after the wake');
		await settle('the laptop holds the second row', async () =>
			(await laptop.report()).titles.includes('after the wake'),
		);
		// The push was answered as well as relayed. A woken object that stores
		// nothing and answers nothing still lets the laptop keep the first row, so
		// without this the sender's side of the wake goes unmeasured.
		await settle(
			'the phone is acknowledged',
			async () => (await phone.report()).inFlight === false,
		);

		const stat = await lab.authority.stat();
		// CONTROL: a different incarnation is the evidence that an eviction really
		// happened. Everything else in this test passes without one.
		expect(stat.incarnation).not.toBe(before);
		// And the sockets came back with the object rather than being reopened.
		expect(stat.sockets).toBe(2);
		// The authority really stored the second push rather than dropping it.
		expect(stat.head).toBe(2);
		expectHealthy(await laptop.report(), ['before the wake', 'after the wake']);
		expectHealthy(await phone.report(), ['before the wake', 'after the wake']);
	});

	it('CONTROL: the same traffic without an eviction keeps ONE incarnation', async () => {
		// Without this, "the incarnation changed" is also what a value minted per
		// call, or an object being torn down by something other than the eviction,
		// would look like.
		const lab = openLab('control-no-eviction');
		const phone = lab.peer('phone');
		const laptop = lab.peer('laptop');
		await phone.openSocket(lab.partition);
		await laptop.openSocket(lab.partition);

		phone.write('before');
		await settle('the laptop holds the first row', async () =>
			(await laptop.report()).titles.includes('before'),
		);
		const before = (await lab.authority.stat()).incarnation;

		phone.write('after');
		await settle('the laptop holds the second row', async () =>
			(await laptop.report()).titles.includes('after'),
		);

		await settle(
			'the phone is acknowledged',
			async () => (await phone.report()).inFlight === false,
		);

		const stat = await lab.authority.stat();
		expect(stat.incarnation).toBe(before);
		expect(stat.sockets).toBe(2);
		expect(stat.head).toBe(2);
		expectHealthy(await laptop.report(), ['before', 'after']);
		expectHealthy(await phone.report(), ['before', 'after']);
	});
});

describe('a woken object re-sends rather than skipping', () => {
	it('the peer is handed entries it already has, and ends up correct anyway', async () => {
		// The claim `positionOf` makes out loud: the attachment is written BEFORE
		// the cursor moves, so a woken object reads a position that is behind what
		// it really sent. It re-sends, and every re-send is idempotent. A shipped
		// bug reported exactly this re-delivery as a `Gap`, so the assertion is
		// both halves: the re-delivery happened, and nothing complained about it.
		const lab = openLab('resends');
		const phone = lab.peer('phone');
		const laptop = lab.peer('laptop');
		await phone.openSocket(lab.partition);
		await laptop.openSocket(lab.partition);

		phone.write('one');
		await settle(
			'the laptop reaches position 1',
			async () => (await laptop.report()).cursor === 1,
		);
		const before = (await lab.authority.stat()).incarnation;

		await evictDurableObject(lab.authority);

		phone.write('two');
		await settle(
			'the laptop reaches position 2',
			async () => (await laptop.report()).cursor === 2,
		);

		const stat = await lab.authority.stat();
		expect(stat.incarnation).not.toBe(before);
		const report = await laptop.report();
		// The wake really did re-send: position 1 arrived a second time, after this
		// peer had already applied it.
		expect(report.redeliveredEntries).toContain(1);
		// And it was harmless. No `Gap`, no `Unapplyable`, no resync owed, and the
		// rows are exactly the two that were written, once each.
		expectHealthy(report, ['one', 'two']);
		expect(report.cursor).toBe(2);
	});

	it('CONTROL: without an eviction nothing is ever re-delivered', async () => {
		// The re-delivery above has to be caused by the wake. If ordinary traffic
		// re-sends too, that assertion proves nothing about hibernation.
		const lab = openLab('control-no-resend');
		const phone = lab.peer('phone');
		const laptop = lab.peer('laptop');
		await phone.openSocket(lab.partition);
		await laptop.openSocket(lab.partition);

		phone.write('one');
		await settle(
			'the laptop reaches position 1',
			async () => (await laptop.report()).cursor === 1,
		);
		phone.write('two');
		await settle(
			'the laptop reaches position 2',
			async () => (await laptop.report()).cursor === 2,
		);

		const report = await laptop.report();
		expect(report.redeliveredEntries).toEqual([]);
		expect(report.redeliveredSnapshots).toEqual([]);
		expectHealthy(report, ['one', 'two']);
	});
});

describe('the snapshot path survives a wake', () => {
	it('a connection served by a snapshot wakes, is served it again, and converges', async () => {
		// The most extreme form of "behind, never ahead", and the only arrangement
		// that reaches it. A connection catching up to a snapshot has its position
		// written BEFORE the cursor jumps, so it is left at 0; anything sent after
		// the snapshot writes a later position over it, and then the wake re-sends
		// an entry instead. So the tail has to be empty when the device arrives,
		// which is exactly the case the snapshot exists for: the entries it would
		// otherwise have read are gone.
		const lab = openLab('snapshot');
		const phone = lab.peer('phone');
		await phone.openSocket(lab.partition);

		// One entry past the authority's 64 KB floor is enough on its own: the
		// authority asks for a snapshot as soon as the tail outgrows the snapshot
		// it holds, and taking one deletes every entry it covers. Hundreds of
		// small rows would get there too, at hundreds of round trips.
		await phone.writeLarge('a big paste', 70_000);
		await settle('a snapshot replaces the whole log', async () => {
			const stat = await lab.authority.stat();
			return stat.head > 0 && stat.snapshot === stat.head && stat.entries === 0;
		});
		const snapshotPosition = (await lab.authority.stat()).snapshot;

		// A device that has never seen this partition. There is no tail at all, so
		// the snapshot is the only thing that can serve it.
		const tablet = lab.peer('tablet');
		await tablet.openSocket(lab.partition);
		await settle('the tablet adopts the snapshot', async () =>
			(await tablet.report()).titles.includes('a big paste'),
		);
		// CONTROL: nothing has been re-delivered yet, so what shows up after the
		// eviction was caused by the wake.
		expect((await tablet.report()).redeliveredSnapshots).toEqual([]);
		const before = (await lab.authority.stat()).incarnation;

		await evictDurableObject(lab.authority);

		phone.write('after the wake');
		await settle('the tablet holds the second row', async () =>
			(await tablet.report()).titles.includes('after the wake'),
		);

		const stat = await lab.authority.stat();
		expect(stat.incarnation).not.toBe(before);
		const report = await tablet.report();
		// The woken object handed it the whole snapshot again, and the peer
		// ignored it rather than adopting it and moving backwards.
		expect(report.redeliveredSnapshots).toEqual([snapshotPosition]);
		expectHealthy(report, ['a big paste', 'after the wake']);
	});
});
