/**
 * Data Sync Supervisor Tests
 *
 * Verifies that sync attachment owns a continuous exchange loop rather than a
 * one-shot call.
 *
 * Key behaviors:
 * - A committed local write wakes exchange immediately
 * - Transport failure reports offline and scheduled retry recovers
 * - Credential absence pauses exchange until credentials return
 * - Status transitions are observable
 * - Parked refused work reports pending, never idle
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { defineTable } from './definitions.js';
import { createEpicenter } from './epicenter.js';
import type { ExchangeRequest, ExchangeResponse } from './protocol/index.js';
import { openReplica } from './replica/index.js';
import type {
	SyncCredentialProvider,
	SyncSchedule,
} from './sync-supervisor.js';

const notes = defineTable({
	namespace: 'so.epicenter.tests',
	table: 'supervisor-notes',
	fields: { title: field.string() },
});

function setup() {
	const raw = new Database(':memory:');
	const database = createBunSqliteAdapter(raw);
	const replica = expectOk(openReplica({ database }));
	const scheduled: Array<{ task: () => void; cancelled: boolean }> = [];
	const schedule: SyncSchedule = (task) => {
		const entry = { task, cancelled: false };
		scheduled.push(entry);
		return () => {
			entry.cancelled = true;
		};
	};
	const epicenter = createEpicenter({
		replica,
		database,
		scheduleSync: schedule,
		syncIntervalMs: 60_000,
	});
	return { raw, epicenter, scheduled };
}

function successfulResponse(request: ExchangeRequest): ExchangeResponse {
	return {
		lifetimeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
		...(request.batch === undefined
			? {}
			: {
					receipt: {
						seq: request.batch.seq,
						digest: request.batch.digest,
					},
				}),
		through: request.after,
		records: [],
		more: false,
	};
}

function createCredentials(
	initial: string | undefined,
): SyncCredentialProvider & {
	set(value: string | undefined): void;
} {
	let value = initial;
	const listeners = new Set<() => void>();
	return {
		get: () => value,
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		set(next) {
			value = next;
			for (const listener of listeners) listener();
		},
	};
}

async function waitFor(check: () => boolean): Promise<void> {
	for (let attempt = 0; attempt < 50; attempt += 1) {
		if (check()) return;
		await Bun.sleep(1);
	}
	throw new Error('Timed out waiting for supervisor state');
}

test('local write triggers an exchange without waiting for the interval', async () => {
	const { raw, epicenter } = setup();
	let exchanges = 0;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange(request) {
				exchanges += 1;
				return successfulResponse(request);
			},
		}),
	);
	const initial = exchanges;
	await epicenter.bind({ tables: { notes }, values: {} }).tables.notes.create({
		title: 'wake',
	});
	await waitFor(() => exchanges > initial);
	expect(epicenter.syncStatus.state).toBe('idle');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('network failure reports offline and scheduled retry recovers', async () => {
	const { raw, epicenter, scheduled } = setup();
	let isOffline = true;
	const states: string[] = [];
	epicenter.subscribeSyncStatus((status) => states.push(status.state));
	const failed = await epicenter.attachSync({
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
		exchange(request) {
			if (isOffline) throw new Error('network unavailable');
			return successfulResponse(request);
		},
	});
	expectErr(failed);
	expect(epicenter.syncStatus.state).toBe('offline');
	expect(epicenter.syncStatus.lastError?.message).toContain(
		'network unavailable',
	);
	isOffline = false;
	const retry = scheduled.find((entry) => !entry.cancelled);
	expect(retry).toBeDefined();
	retry?.task();
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(states).toContain('syncing');
	expect(states).toContain('offline');
	expect(states.at(-1)).toBe('idle');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('a refused change parks and the drained supervisor reports pending, not idle', async () => {
	const { raw, epicenter } = setup();
	const data = epicenter.bind({ tables: { notes }, values: {} });
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			exchange(request) {
				if (request.batch !== undefined) {
					return {
						refusal: 'change-inadmissible',
						lifetimeId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
						seq: request.batch.seq,
						digest: request.batch.digest,
						changeIndex: 0,
						reason: 'record-bound',
					};
				}
				return successfulResponse(request);
			},
		}),
	);
	await data.tables.notes.create({ title: 'refused upstream' });
	await waitFor(() => epicenter.syncStatus.state === 'pending');
	expect(epicenter.syncStatus.state).toBe('pending');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});

test('credential absence pauses and reports authentication-required', async () => {
	const { raw, epicenter } = setup();
	const credentials = createCredentials(undefined);
	let exchanges = 0;
	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			credentials,
			exchange(request) {
				exchanges += 1;
				return successfulResponse(request);
			},
		}),
	);
	expect(epicenter.syncStatus.state).toBe('authentication-required');
	expect(exchanges).toBe(0);
	credentials.set('token');
	await waitFor(() => epicenter.syncStatus.state === 'idle');
	expect(exchanges).toBe(1);
	credentials.set(undefined);
	expect(epicenter.syncStatus.state).toBe('authentication-required');
	await epicenter[Symbol.asyncDispose]();
	raw.close();
});
