/**
 * V1 Sync Supervisor Tests
 *
 * Proves the two lanes are genuinely independent rather than two calls behind
 * one schedule: each keeps its own wake, its own backoff, and its own failure,
 * while one status surface and one disposal still cover both.
 *
 * Key behaviors:
 * - A failing facts lane does not stop local work from settling, and vice versa
 * - Submissions wake on a local write; facts wake on an interval
 * - Retry backoff is strictly positive and grows, so no lane can spin
 * - A document-only wake drains documents without buying a fact read
 * - Status is worst-of across lanes; disposal cancels every pending wake
 */

import { describe, expect, test } from 'bun:test';

import { Ok, type Result } from 'wellcrafted/result';

import type { ParkedIntent } from './protocol/v1/index.js';
import type {
	ReplicaV1,
	ReplicaV1Error,
	SubmissionPass,
} from './replica/v1-replica.js';
import { ReplicaV1Error as Errors } from './replica/v1-replica.js';
import {
	createSyncSupervisorV1,
	type SyncSchedule,
	type SyncStatus,
} from './v1-sync-supervisor.js';

/** A scheduler that never fires on its own, so tests drive time explicitly. */
function createManualSchedule() {
	let nextId = 1;
	const pending = new Map<number, { task: () => void; delayMs: number }>();
	const delays: number[] = [];
	const schedule: SyncSchedule = (task, delayMs) => {
		const id = nextId;
		nextId += 1;
		pending.set(id, { task, delayMs });
		delays.push(delayMs);
		return () => pending.delete(id);
	};
	return {
		schedule,
		delays,
		get pendingCount() {
			return pending.size;
		},
		/** Fire every currently scheduled task once, oldest first. */
		fireAll() {
			const entries = [...pending.entries()].sort(
				(left, right) => left[0] - right[0],
			);
			pending.clear();
			for (const [, entry] of entries) entry.task();
		},
		/**
		 * Fire only tasks scheduled at or under `maxDelayMs`.
		 *
		 * The lanes are told apart by their cadence, so a test that means "the
		 * document coalesce fired" must not also fire the 30 second facts wake
		 * sitting in the same queue.
		 */
		fireUpTo(maxDelayMs: number) {
			const entries = [...pending.entries()]
				.sort((left, right) => left[0] - right[0])
				.filter(([, entry]) => entry.delayMs <= maxDelayMs);
			for (const [id] of entries) pending.delete(id);
			for (const [, entry] of entries) entry.task();
		},
	};
}

type ReplicaStub = {
	replica: ReplicaV1;
	factsCalls: number;
	submissionCalls: number;
	wakeOutbox(): void;
	failFacts(error?: ReplicaV1Error): void;
	hangFacts(gate: () => Promise<void>): void;
	reportPass(pass: SubmissionPass): void;
	reportParked(entries: readonly ParkedIntent[]): void;
	reportPassOnce(first: SubmissionPass, rest: SubmissionPass): void;
	failSubmissions(error?: ReplicaV1Error): void;
	succeed(): void;
};

const transportFailure = (): ReplicaV1Error =>
	Errors.TransportFailed({ cause: new Error('offline') }).error;

function createReplicaStub(): ReplicaStub {
	let outboxListener: (() => void) | undefined;
	let factsError: ReplicaV1Error | undefined;
	let factsGate: (() => Promise<void>) | undefined;
	let submissionPass: SubmissionPass = { kind: 'idle' };
	let submissionPassAfter: SubmissionPass | undefined;
	let parkedList: readonly ParkedIntent[] = [];
	let submissionsError: ReplicaV1Error | undefined;
	const state = {
		factsCalls: 0,
		submissionCalls: 0,
	};

	const replica = {
		subscribeOutbox(listener: () => void) {
			outboxListener = listener;
			return () => {
				outboxListener = undefined;
			};
		},
		subscribe() {
			return () => undefined;
		},
		async pullFacts(): Promise<Result<void, ReplicaV1Error>> {
			state.factsCalls += 1;
			if (factsGate !== undefined) await factsGate();
			return factsError === undefined
				? Ok(undefined)
				: { data: null, error: factsError };
		},
		parkedDiagnostics(): Result<readonly ParkedIntent[], ReplicaV1Error> {
			return Ok(parkedList);
		},
		async pushSubmissions(): Promise<Result<SubmissionPass, ReplicaV1Error>> {
			state.submissionCalls += 1;
			if (submissionsError !== undefined) {
				return { data: null, error: submissionsError };
			}
			const pass = submissionPass;
			if (submissionPassAfter !== undefined) {
				submissionPass = submissionPassAfter;
				submissionPassAfter = undefined;
			}
			return Ok(pass);
		},
	} as unknown as ReplicaV1;

	return {
		replica,
		get factsCalls() {
			return state.factsCalls;
		},
		get submissionCalls() {
			return state.submissionCalls;
		},
		wakeOutbox() {
			outboxListener?.();
		},
		failFacts(error = transportFailure()) {
			factsError = error;
		},
		hangFacts(gate: () => Promise<void>) {
			factsGate = gate;
		},
		reportPass(pass: SubmissionPass) {
			submissionPass = pass;
		},
		reportParked(entries: readonly ParkedIntent[]) {
			parkedList = entries;
		},
		/** Report `first` on the next pass, then `rest` from then on. */
		reportPassOnce(first: SubmissionPass, rest: SubmissionPass) {
			submissionPass = first;
			submissionPassAfter = rest;
		},
		failSubmissions(error = transportFailure()) {
			submissionsError = error;
		},
		succeed() {
			factsError = undefined;
			submissionsError = undefined;
		},
	};
}

const transport = {
	async readFacts() {
		return { kind: 'response', body: {} } as const;
	},
	async submit() {
		return { kind: 'response', body: {} } as const;
	},
};

function setup(options: { documentCoalesceMs?: number } = {}) {
	const clock = createManualSchedule();
	const stub = createReplicaStub();
	const documentDrains: number[] = [];
	const supervisor = createSyncSupervisorV1({
		replica: stub.replica,
		schedule: clock.schedule,
		drainDocuments: async () => {
			documentDrains.push(1);
			return Ok(undefined);
		},
		...options,
	});
	return { clock, stub, supervisor, documentDrains };
}

/** Let every queued microtask settle, so an awaited lane cycle completes. */
async function settle(): Promise<void> {
	for (let turn = 0; turn < 5; turn += 1) {
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}

describe('the lanes progress independently', () => {
	test('a failing facts lane does not stop local work from settling', async () => {
		const { stub, supervisor } = setup();
		stub.failFacts();
		await supervisor.attach({ transport });
		await settle();

		expect(stub.factsCalls).toBeGreaterThan(0);
		// Attach already drains any durable pending work, so measure from there.
		const submissionsBefore = stub.submissionCalls;
		// The write still settles even though the feed is down.
		stub.wakeOutbox();
		await settle();

		expect(stub.submissionCalls).toBe(submissionsBefore + 1);
	});

	test('a failing submissions lane does not stop the replica learning facts', async () => {
		const { stub, supervisor } = setup();
		stub.failSubmissions();
		await supervisor.attach({ transport });
		await settle();
		stub.wakeOutbox();
		await settle();
		const factsBefore = stub.factsCalls;

		supervisor.requestFacts();
		await settle();

		expect(stub.factsCalls).toBeGreaterThan(factsBefore);
	});

	test('a local write wakes only the submissions lane', async () => {
		const { stub, supervisor } = setup();
		await supervisor.attach({ transport });
		await settle();
		const factsBefore = stub.factsCalls;
		const submissionsBefore = stub.submissionCalls;

		stub.wakeOutbox();
		await settle();

		expect(stub.submissionCalls).toBe(submissionsBefore + 1);
		expect(stub.factsCalls).toBe(factsBefore);
	});

	/**
	 * Only a local write or a fact read creates submission work, so the lane never
	 * schedules a wake of its own: a periodic submissions timer would be a
	 * guaranteed-empty round trip on every quiet interval.
	 *
	 * Asserted on scheduled wakes rather than call counts, because the facts lane
	 * legitimately nudges submissions after learning facts. A nudge is not a
	 * cadence; what must not exist is a timer this lane set for itself.
	 */
	test('the submissions lane schedules no wake of its own', async () => {
		const { clock, stub, supervisor } = setup();
		await supervisor.attach({ transport });
		await settle();
		// Only the facts lane's periodic wake should be outstanding.
		expect(clock.pendingCount).toBe(1);

		stub.wakeOutbox();
		await settle();

		expect(stub.submissionCalls).toBeGreaterThan(0);
		expect(clock.pendingCount).toBe(1);
	});
});

describe('attach settles the first cycle of both lanes', () => {
	/**
	 * `attach` promises the first cycle was attempted, not that a timer was set.
	 * A caller that attaches and immediately reads expects to see what the
	 * authority already had, and a replica coming back online with durable
	 * pending work expects it sent. Returning before either lane ran turned both
	 * into races that only showed up as flaky reads.
	 */
	test('both lanes have run by the time attach resolves', async () => {
		const { stub, supervisor } = setup();

		await supervisor.attach({ transport });

		// Facts, then submissions, then facts again: the second fact cycle is
		// where documents drain, and publication needs rows the submissions cycle
		// has just created at the authority.
		expect(stub.factsCalls).toBe(2);
		// At least once; a successful fact read also nudges this lane, because
		// learning facts is what binds the lifetime submissions need.
		expect(stub.submissionCalls).toBeGreaterThanOrEqual(1);
	});

	test('a transport that never answers leaves attach pending', async () => {
		const { stub, supervisor } = setup();
		const gates: (() => void)[] = [];
		stub.hangFacts(() => new Promise<void>((resolve) => gates.push(resolve)));

		let settled = false;
		const attaching = supervisor.attach({ transport }).then(() => {
			settled = true;
		});
		await settle();

		expect(settled).toBe(false);
		// Release each fact cycle attach waits on, in order.
		while (!settled) {
			const gate = gates.shift();
			if (gate === undefined) break;
			gate();
			await settle();
		}
		await attaching;
		expect(settled).toBe(true);
	});
});

describe('a lane that made no progress does not re-request itself', () => {
	/**
	 * The regression this exists for. A replica may not submit before the facts
	 * feed binds the authority lifetime, and that pass used to be reported as
	 * "pending work remains", so the lane re-requested itself immediately and the
	 * loop had no exit: nothing in that pass consumes work.
	 *
	 * In Bun it burned CPU. In a browser it was worse, because the loop stayed on
	 * the microtask queue and starved the worker's message loop, so no read could
	 * be served at all while the facts feed was unreachable. That is what broke
	 * the `hung-sync-continuity` browser evidence cell.
	 */
	test('an awaiting-lifetime pass runs once, not forever', async () => {
		const { stub, supervisor } = setup();
		stub.reportPass({ kind: 'awaiting-lifetime' });
		// A hung facts feed is what leaves the lifetime unbound in practice.
		stub.hangFacts(() => new Promise<void>(() => undefined));

		void supervisor.attach({ transport });
		await settle();
		const afterAttach = stub.submissionCalls;

		stub.wakeOutbox();
		await settle();

		// One pass per wake. A spin shows up here as an unbounded count.
		expect(afterAttach).toBeLessThanOrEqual(1);
		expect(stub.submissionCalls).toBeLessThanOrEqual(afterAttach + 1);
	});

	test('an idle pass runs once per wake', async () => {
		const { stub, supervisor } = setup();
		stub.reportPass({ kind: 'idle' });
		await supervisor.attach({ transport });
		await settle();
		const afterAttach = stub.submissionCalls;

		stub.wakeOutbox();
		await settle();

		expect(stub.submissionCalls).toBe(afterAttach + 1);
	});

	/**
	 * The one outcome that may ask for another pass, because it consumed work and
	 * therefore terminates. The stub retires its own work to model that: a real
	 * settlement drains the outbox, which is exactly why repeating is safe here
	 * and unsafe for the two outcomes above.
	 */
	test('a settled pass with more pending work runs again, then stops', async () => {
		const { stub, supervisor } = setup();
		stub.reportPassOnce(
			{ kind: 'settled', hasMorePending: true },
			{
				kind: 'idle',
			},
		);
		await supervisor.attach({ transport });
		await settle();

		// It ran again after settling, and it stopped. The exact count also
		// includes the nudge each successful fact read gives this lane, so the
		// bound is generous on purpose: what matters is that it is a bound at all.
		expect(stub.submissionCalls).toBeGreaterThanOrEqual(2);
		expect(stub.submissionCalls).toBeLessThan(10);
	});
});

describe('retry cadence cannot spin', () => {
	test('every scheduled delay is strictly positive', async () => {
		const { clock, stub, supervisor } = setup();
		stub.failFacts();
		await supervisor.attach({ transport });
		await settle();
		clock.fireAll();
		await settle();
		clock.fireAll();
		await settle();

		expect(clock.delays.length).toBeGreaterThan(0);
		for (const delay of clock.delays) expect(delay).toBeGreaterThan(0);
	});

	test('transport backoff grows across consecutive failures', async () => {
		const { clock, stub, supervisor } = setup();
		stub.failFacts();
		await supervisor.attach({ transport });
		await settle();
		const first = clock.delays.at(-1);
		clock.fireAll();
		await settle();
		const second = clock.delays.at(-1);

		expect(first).toBeGreaterThan(0);
		expect(second).toBeGreaterThan(first ?? 0);
	});

	/**
	 * A protocol or corruption failure is not transport trouble, so it must not
	 * inherit the fast retry: it falls back to the periodic safety wake instead.
	 */
	test('a non-transport failure waits for the safety wake, not the fast retry', async () => {
		const { clock, stub, supervisor } = setup();
		stub.failFacts(Errors.Corrupted({ detail: 'bad' }).error);
		await supervisor.attach({ transport });
		await settle();

		expect(clock.delays.at(-1)).toBe(30_000);
	});

	test('a recovered lane resets its backoff', async () => {
		const { clock, stub, supervisor } = setup();
		stub.failFacts();
		await supervisor.attach({ transport });
		await settle();
		clock.fireAll();
		await settle();
		stub.succeed();
		clock.fireAll();
		await settle();
		const afterRecovery = clock.delays.at(-1);

		stub.failFacts();
		supervisor.requestFacts();
		await settle();

		// Back to the base delay rather than continuing the earlier growth.
		expect(afterRecovery).toBe(30_000);
		expect(clock.delays.at(-1)).toBe(500);
	});
});

describe('documents ride the facts lane', () => {
	test('a document-only wake drains documents without reading facts', async () => {
		const { clock, stub, supervisor, documentDrains } = setup({
			documentCoalesceMs: 10,
		});
		await supervisor.attach({ transport });
		await settle();
		const factsBefore = stub.factsCalls;
		const drainsBefore = documentDrains.length;

		supervisor.requestDocumentDrain();
		clock.fireUpTo(10);
		await settle();

		expect(documentDrains.length).toBeGreaterThan(drainsBefore);
		expect(stub.factsCalls).toBe(factsBefore);
	});

	test('a full facts cycle drains documents after learning facts', async () => {
		const { stub, supervisor, documentDrains } = setup();
		await supervisor.attach({ transport });
		await settle();

		// Two fact cycles on attach, and documents drain at the tail of each.
		expect(stub.factsCalls).toBe(2);
		expect(documentDrains).toHaveLength(2);
	});
});

describe('one status surface spans both lanes', () => {
	test('it reports offline while either lane is failing', async () => {
		const { stub, supervisor } = setup();
		const seen: SyncStatus[] = [];
		supervisor.subscribe((status) => seen.push(status));
		stub.failSubmissions();
		await supervisor.attach({ transport });
		await settle();
		stub.wakeOutbox();
		await settle();

		// The facts lane succeeded, but submissions did not, so the caller must
		// not be told everything is idle.
		expect(supervisor.status.state).toBe('offline');
		expect(seen.some((status) => status.state === 'syncing')).toBe(true);
	});

	test('it reaches idle only when both lanes are clean', async () => {
		const { stub, supervisor } = setup();
		await supervisor.attach({ transport });
		await settle();
		stub.wakeOutbox();
		await settle();

		expect(supervisor.status.state).toBe('idle');
	});

	test('missing credentials short-circuit both lanes', async () => {
		const { stub, supervisor } = setup();
		await supervisor.attach({
			transport,
			credentials: { get: () => undefined },
		});
		await settle();

		expect(supervisor.status.state).toBe('authentication-required');
		expect(stub.factsCalls).toBe(0);
		expect(stub.submissionCalls).toBe(0);
	});
});

describe('the parked diagnostic is reachable through status', () => {
	const parkedEntry: ParkedIntent = {
		address: {
			kind: 'row',
			namespace: 'so.epicenter.notes',
			tableName: 'rows',
			rowId: 'row1aaaaaaaaaaaaaaaaaaaa',
		},
		code: 'fact-too-large',
		measuredBytes: 600_000,
		limitBytes: 520_192,
	};

	/**
	 * ADR-0163 keeps a parked intent visible "with an explicit diagnostic" that
	 * "does not retry automatically". Explicit has to mean reachable, or a user
	 * sees local state that silently never settles. Nothing else in the status
	 * conveys it: the lanes are healthy, so the state is `idle` and `lastError` is
	 * undefined, which is exactly why the diagnostic needs its own field.
	 */
	test('a parked address is reported while both lanes stay healthy', async () => {
		const { stub, supervisor } = setup();
		stub.reportParked([parkedEntry]);

		await supervisor.attach({ transport });
		await settle();

		expect(supervisor.status.state).toBe('idle');
		expect(supervisor.status.lastError).toBeUndefined();
		expect(supervisor.status.parked).toEqual([parkedEntry]);
	});

	test('subscribers are notified when an address becomes parked', async () => {
		const { stub, supervisor } = setup();
		const seen: (readonly ParkedIntent[])[] = [];
		supervisor.subscribe((status) => seen.push(status.parked));
		await supervisor.attach({ transport });
		await settle();
		expect(seen.at(-1)).toEqual([]);

		stub.reportParked([parkedEntry]);
		stub.wakeOutbox();
		await settle();

		expect(seen.at(-1)).toEqual([parkedEntry]);
	});

	test('it clears once the address stops being parked', async () => {
		const { stub, supervisor } = setup();
		stub.reportParked([parkedEntry]);
		await supervisor.attach({ transport });
		await settle();
		expect(supervisor.status.parked).toHaveLength(1);

		stub.reportParked([]);
		stub.wakeOutbox();
		await settle();

		expect(supervisor.status.parked).toEqual([]);
	});
});

describe('disposal', () => {
	test('it cancels every pending wake and stops both lanes', async () => {
		const { clock, stub, supervisor } = setup();
		stub.failFacts();
		await supervisor.attach({ transport });
		await settle();
		expect(clock.pendingCount).toBeGreaterThan(0);

		const factsBefore = stub.factsCalls;
		const submissionsBefore = stub.submissionCalls;
		supervisor.dispose();

		expect(clock.pendingCount).toBe(0);
		supervisor.requestFacts();
		supervisor.requestSubmissions();
		stub.wakeOutbox();
		await settle();
		expect(stub.factsCalls).toBe(factsBefore);
		expect(stub.submissionCalls).toBe(submissionsBefore);
	});
});
