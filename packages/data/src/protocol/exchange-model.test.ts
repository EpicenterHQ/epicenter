/**
 * Durable-Watermark Exchange Protocol Model
 *
 * Executable model of the V1 paging collapse: one durable replica watermark,
 * a transient per-scan through bound, and a continuation fact instead of a
 * cursor. Uses the real change, record, digest, and fold vocabulary.
 *
 * Key behaviors:
 * - Each installed page durably advances `after`; a crash forgets only the
 *   transient `through` and never reinstalls a completed page
 * - A fixed `through` guarantees termination under sustained writes
 * - Benign-noop touches re-deliver authority truth through ordinary scans
 */
import { describe, expect, test } from 'bun:test';

import {
	batchDigest,
	type Change,
	foldChange,
	type Record as SyncRecord,
	scalarAddressKey,
	scalarAddressOf,
} from './index.js';

const NAMESPACE = 'so.epicenter.model';
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';

const addressOf = (value: Change | SyncRecord): string =>
	scalarAddressKey(scalarAddressOf(value));

const setValue = (value: string, payload: unknown): Change => ({
	kind: 'set',
	namespace: NAMESPACE,
	value,
	payload: payload as Change extends { payload: infer P } ? P : never,
});

function createAuthority() {
	let maximumSequence = 0;
	let appliedChangeCount = 0;
	const state = new Map<string, SyncRecord>();
	const batches = new Map<string, { seq: number; digest: string }>();

	function submit(change: Change) {
		const address = addressOf(change);
		const folded = foldChange(state.get(address), change, maximumSequence + 1);
		if (folded.kind === 'applied') {
			maximumSequence += 1;
			appliedChangeCount += 1;
			state.set(address, structuredClone(folded.record));
		} else if (folded.kind === 'noop' && folded.current !== undefined) {
			// Touch: re-deliver authority truth for a suppressed address.
			maximumSequence += 1;
			state.set(address, {
				...structuredClone(folded.current),
				changedSequence: maximumSequence,
			});
		}
		return folded;
	}

	function applyBatch(replicaId: string, seq: number, changes: Change[]) {
		const digest = batchDigest(changes);
		const prior = batches.get(replicaId);
		if (prior?.seq === seq && prior.digest === digest) return prior;
		if (seq !== (prior?.seq ?? 0) + 1) throw new Error('batch-conflict');
		for (const change of changes) submit(change);
		const receipt = { seq, digest };
		batches.set(replicaId, receipt);
		return receipt;
	}

	function page(after: number, through: number | undefined, pageSize: number) {
		const boundedThrough = through ?? maximumSequence;
		const eligible = [...state.values()]
			.filter(
				(record) =>
					record.changedSequence > after &&
					record.changedSequence <= boundedThrough,
			)
			.sort((left, right) => left.changedSequence - right.changedSequence);
		const records = eligible
			.slice(0, pageSize)
			.map((record) => structuredClone(record));
		return {
			through: boundedThrough,
			records,
			more: eligible.length > pageSize,
		};
	}

	return {
		submit,
		applyBatch,
		page,
		get maximumSequence() {
			return maximumSequence;
		},
		get appliedChangeCount() {
			return appliedChangeCount;
		},
		get(address: string) {
			const record = state.get(address);
			return record === undefined ? undefined : structuredClone(record);
		},
		records() {
			return [...state.values()].map((record) => structuredClone(record));
		},
	};
}

function createClient(after = 0) {
	let durableAfter = after;
	let installEffectCount = 0;
	const state = new Map<string, SyncRecord>();
	const installed = new Set<string>();
	return {
		get durableAfter() {
			return durableAfter;
		},
		get installEffectCount() {
			return installEffectCount;
		},
		/** One page transaction: install records, then advance the watermark. */
		installPage(page: {
			through: number;
			records: SyncRecord[];
			more: boolean;
		}) {
			for (const record of page.records) {
				const effect = `${addressOf(record)}\0${record.changedSequence}`;
				if (!installed.has(effect)) {
					installed.add(effect);
					installEffectCount += 1;
				}
				const address = addressOf(record);
				const current = state.get(address);
				if (
					current === undefined ||
					current.changedSequence < record.changedSequence
				) {
					state.set(address, structuredClone(record));
				}
			}
			durableAfter = page.more
				? (page.records.at(-1)?.changedSequence ?? page.through)
				: page.through;
		},
		get(address: string) {
			return state.get(address);
		},
		records() {
			return [...state.values()].sort((left, right) =>
				addressOf(left).localeCompare(addressOf(right)),
			);
		},
	};
}

/** One uninterrupted scan: sample through on the first page, then continue. */
function drain(
	authority: ReturnType<typeof createAuthority>,
	client: ReturnType<typeof createClient>,
	pageSize: number,
) {
	let through: number | undefined;
	const returned: SyncRecord[] = [];
	while (true) {
		const page = authority.page(client.durableAfter, through, pageSize);
		client.installPage(page);
		returned.push(...page.records);
		if (!page.more) return returned;
		through = page.through;
	}
}

function permutations<T>(values: T[]): T[][] {
	if (values.length === 0) return [[]];
	return values.flatMap((value, index) =>
		permutations(values.filter((_, candidate) => candidate !== index)).map(
			(rest) => [value, ...rest],
		),
	);
}

describe('durable-watermark latest-state exchange', () => {
	test('1. bounded writer orders and mid-page overwrites never skip current in-window records', () => {
		const keys = ['a', 'b', 'c'];
		for (const order of permutations(keys)) {
			for (const overwritten of [undefined, ...keys]) {
				const authority = createAuthority();
				const client = createClient();
				for (const key of order) authority.submit(setValue(key, key));
				const through = authority.maximumSequence;
				let scanThrough: number | undefined;
				const returned: SyncRecord[] = [];
				let pageNumber = 0;
				while (true) {
					const page = authority.page(client.durableAfter, scanThrough, 1);
					client.installPage(page);
					returned.push(...page.records);
					pageNumber += 1;
					if (pageNumber === 1 && overwritten !== undefined) {
						authority.submit(setValue(overwritten, 'new'));
					}
					if (!page.more) break;
					scanThrough = page.through;
				}
				for (const current of authority.records()) {
					if (current.changedSequence <= through) {
						expect(
							returned.some(
								(record) =>
									addressOf(record) === addressOf(current) &&
									record.changedSequence === current.changedSequence,
							),
						).toBe(true);
					} else {
						expect(current.changedSequence).toBeGreaterThan(through);
					}
				}
				drain(authority, client, 1);
				expect(client.records()).toEqual(
					authority
						.records()
						.sort((left, right) =>
							addressOf(left).localeCompare(addressOf(right)),
						),
				);
			}
		}
	});

	test('2. each page durably advances the watermark and a crash reinstalls nothing', () => {
		const authority = createAuthority();
		for (const key of ['a', 'b', 'c', 'd', 'e']) {
			authority.submit(setValue(key, key));
		}
		const client = createClient();

		// First scan: two pages install, then the process crashes and forgets
		// the transient through.
		const first = authority.page(client.durableAfter, undefined, 2);
		client.installPage(first);
		expect(client.durableAfter).toBe(2);
		const second = authority.page(client.durableAfter, first.through, 2);
		client.installPage(second);
		expect(client.durableAfter).toBe(4);
		const effectsBeforeCrash = client.installEffectCount;

		// Fresh scan from durable progress with a newly sampled through.
		const resumed = authority.page(client.durableAfter, undefined, 2);
		expect(resumed.records.every((record) => record.changedSequence > 4)).toBe(
			true,
		);
		client.installPage(resumed);
		expect(resumed.more).toBe(false);
		expect(client.durableAfter).toBe(authority.maximumSequence);
		// No completed page was re-downloaded or re-installed.
		expect(client.installEffectCount).toBe(effectsBeforeCrash + 1);
		expect(client.records()).toEqual(
			authority
				.records()
				.sort((left, right) => addressOf(left).localeCompare(addressOf(right))),
		);
	});

	test('3. a crash between pages with concurrent writes still converges without reinstalling', () => {
		const authority = createAuthority();
		for (const key of ['a', 'b', 'c', 'd']) {
			authority.submit(setValue(key, 1));
		}
		const client = createClient();
		const first = authority.page(client.durableAfter, undefined, 2);
		client.installPage(first);
		// Concurrent writes land while the scan is (about to be) lost.
		authority.submit(setValue('a', 2));
		authority.submit(setValue('e', 1));
		// Crash: restart samples a fresh through covering the new writes.
		drain(authority, client, 2);
		expect(client.records()).toEqual(
			authority
				.records()
				.sort((left, right) => addressOf(left).localeCompare(addressOf(right))),
		);
	});

	test('4. an early-page record overwritten above through appears next exchange', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit(setValue('a', 'a1'));
		authority.submit(setValue('b', 'b1'));
		const first = authority.page(client.durableAfter, undefined, 1);
		client.installPage(first);
		authority.submit(setValue('a', 'a2'));
		const last = authority.page(client.durableAfter, first.through, 1);
		client.installPage(last);
		expect(last.more).toBe(false);
		const current = authority.get(addressOf(setValue('a', 'a2')));
		if (current === undefined) throw new Error('Expected current value');
		expect(drain(authority, client, 1)).toEqual([current]);
	});

	test('5. retrying an identical local batch returns one receipt and applies once', () => {
		const authority = createAuthority();
		const changes: Change[] = [setValue('a', 'a1')];
		const receipt = authority.applyBatch(REPLICA_ID, 1, changes);
		expect(authority.applyBatch(REPLICA_ID, 1, changes)).toBe(receipt);
		expect(authority.appliedChangeCount).toBe(1);
	});

	test('6. a fresh replica receives all current live, tombstone, and unset records', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit({
			kind: 'create',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			fields: { title: 'live' },
		});
		authority.submit({
			kind: 'create',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
			fields: {},
		});
		authority.submit({
			kind: 'delete',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
		});
		authority.submit(setValue('v', 1));
		authority.submit({ kind: 'unset', namespace: NAMESPACE, value: 'v' });
		drain(authority, client, 2);
		expect(client.records()).toEqual(
			authority
				.records()
				.sort((left, right) => addressOf(left).localeCompare(addressOf(right))),
		);
	});

	test('7. a terminal tombstone defeats offline create and update, and the touch re-delivers it', () => {
		const authority = createAuthority();
		authority.submit({
			kind: 'create',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
			fields: {},
		});
		authority.submit({
			kind: 'delete',
			namespace: NAMESPACE,
			table: 'rows',
			rowId: ROW_ID,
		});
		const afterDelete = authority.maximumSequence;
		expect(
			authority.submit({
				kind: 'create',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
				fields: { stale: true },
			}).kind,
		).toBe('noop');
		// The touch moved the tombstone above the stale writer's watermark, so
		// a replica that had already scanned past it sees it again.
		const touched = authority.get(
			addressOf({
				kind: 'delete',
				namespace: NAMESPACE,
				table: 'rows',
				rowId: ROW_ID,
			}),
		);
		expect(touched?.kind).toBe('row-deleted');
		expect(touched?.changedSequence).toBeGreaterThan(afterDelete);
		const staleClient = createClient(afterDelete);
		expect(drain(authority, staleClient, 8)).toEqual([touched ?? []].flat());
	});

	test('8. continuous replacement cannot prevent fixed-through progress', () => {
		const authority = createAuthority();
		const client = createClient();
		authority.submit(setValue('hot', 0));
		let prior = 0;
		for (let index = 1; index <= 8; index += 1) {
			const through = authority.maximumSequence;
			authority.submit(setValue('hot', index));
			const page = authority.page(client.durableAfter, through, 1);
			// The hot record moved above through; the bounded scan still ends.
			expect(page.records).toEqual([]);
			client.installPage(page);
			expect(client.durableAfter).toBeGreaterThan(prior);
			prior = through;
		}
		expect(drain(authority, client, 1)).toHaveLength(1);
	});

	test('9. one last receipt accepts exact retry and rejects gaps or old batches', () => {
		const authority = createAuthority();
		const first: Change[] = [setValue('a', 1)];
		const second: Change[] = [setValue('b', 2)];
		authority.applyBatch(REPLICA_ID, 1, first);
		authority.applyBatch(REPLICA_ID, 2, second);
		expect(() => authority.applyBatch(REPLICA_ID, 1, first)).toThrow(
			'batch-conflict',
		);
		expect(() =>
			authority.applyBatch('ssssssssssssssssssssssss', 2, second),
		).toThrow('batch-conflict');
	});
});
