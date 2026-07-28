/**
 * Typed Data API Tests
 *
 * Verifies inert definitions, Lens binding, classified scalar traversal,
 * committed observation, and local row-document persistence over Bun SQLite.
 *
 * Key behaviors:
 * - Invalid namespaces, invalid local names, and names colliding only by case
 *   fail when the Lens is declared, before any storage work
 * - Conforming rows and values round-trip while invalid stored data is classified
 * - Local and synchronized commits notify borrowed lenses
 * - Row documents persist locally and are revoked by settled row deletion
 *   through any lens, including one that never opened the document
 */
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';

import { field } from '@epicenter/field';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Type } from 'typebox';
import { createLogger, type Logger, memorySink } from 'wellcrafted/logger';
import { expectErr, expectOk } from 'wellcrafted/testing';

import { openBunEpicenter } from './bun.js';
import {
	defineLens,
	defineTable,
	defineValue,
	optional,
} from './definitions.js';
import { createEpicenter, createTableReadMethods } from './epicenter.js';
import {
	type AuthorityState,
	createAuthority,
	type Intent,
	parseFactsRequest,
	parseSubmissionRequest,
	readFacts,
	SCALAR_V1_LIMITS,
	type SubmissionRequest,
	submit,
} from './protocol/v1/index.js';
import {
	openReplicaV1,
	type ScalarTransport,
	type TransportOutcome,
} from './replica/v1-replica.js';

const TEST_NAMESPACE = 'so.epicenter.tests';
const REMOTE_ROW_A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REMOTE_ROW_B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const AUTHORITY_LIFETIME = 'epicenter-test-lifetime';
const REMOTE_REPLICA_ID = 'remoterrrrrrrrrrrrrrrrrr';
const THEME_ADDRESS = {
	kind: 'value',
	namespace: TEST_NAMESPACE,
	valueName: 'theme',
} as const;

function rowAddress(rowId: string) {
	return {
		kind: 'row',
		namespace: TEST_NAMESPACE,
		tableName: 'notes',
		rowId,
	} as const;
}

const notesDefinition = defineTable({
	fields: {
		title: field.string(),
		rank: field.integer(),
		note: optional(field.string()),
		label: optional(field.json(Type.Union([Type.String(), Type.Null()]))),
	},
});

const themeDefinition = defineValue({
	value: field.string(),
});

function setup(log?: Logger) {
	const rawDatabase = new Database(':memory:');
	const database = createBunSqliteAdapter(rawDatabase);
	const replica = expectOk(openReplicaV1({ database }));
	const epicenter = createEpicenter({ replica, database, log });
	return { rawDatabase, database, replica, epicenter };
}

function createScriptedAuthority(lifetime = AUTHORITY_LIFETIME) {
	let state: AuthorityState = expectOk(
		createAuthority(lifetime, SCALAR_V1_LIMITS),
	);

	const transport: ScalarTransport = {
		async readFacts(request): Promise<TransportOutcome> {
			const admitted = parseFactsRequest(request, SCALAR_V1_LIMITS);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const result = readFacts(state, admitted.data, SCALAR_V1_LIMITS);
			if (result.error !== null) {
				return result.error.name === 'LifetimeMismatch'
					? {
							kind: 'refused',
							refusal: {
								code: 'lifetime-mismatch',
								activeLifetime: state.lifetime,
							},
						}
					: { kind: 'refused', refusal: { code: 'sequence-ahead' } };
			}
			return { kind: 'response', body: result.data };
		},
		async submit(request): Promise<TransportOutcome> {
			const admitted = parseSubmissionRequest(request, SCALAR_V1_LIMITS);
			if (admitted.error !== null) throw new Error(admitted.error.message);
			const result = submit(state, admitted.data, SCALAR_V1_LIMITS);
			if (result.error !== null) {
				const refusal =
					result.error.name === 'LifetimeMismatch'
						? ({
								code: 'lifetime-mismatch',
								activeLifetime: state.lifetime,
							} as const)
						: result.error.name === 'SubmissionFork'
							? ({ code: 'submission-fork' } as const)
							: ({ code: 'submission-gap' } as const);
				return { kind: 'refused', refusal };
			}
			state = result.data.state;
			return { kind: 'response', body: result.data.response };
		},
	};

	return {
		transport,
		applyRemote(intents: Intent[], submissionNumber: number) {
			const request: SubmissionRequest = {
				authorityLifetime: state.lifetime,
				replicaId: REMOTE_REPLICA_ID,
				submissionNumber,
				intents,
			};
			const admitted = expectOk(
				parseSubmissionRequest(request, SCALAR_V1_LIMITS),
			);
			state = expectOk(submit(state, admitted, SCALAR_V1_LIMITS)).state;
		},
	};
}

async function waitFor(
	predicate: () => boolean | Promise<boolean>,
): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!(await predicate())) {
		if (Date.now() > deadline) throw new Error('Timed out waiting for sync');
		await Bun.sleep(5);
	}
}

/**
 * ADR-0163 keeps a parked intent visible with an explicit diagnostic. The
 * runtime's status surface is where a caller can reach it, so this pins that the
 * field is part of that surface and not something only the internals can see.
 * The replica and supervisor tests own the behaviour; this owns the reachability.
 */
test('the runtime status surface carries the parked diagnostic', async () => {
	const { epicenter, rawDatabase } = setup();
	try {
		expect(epicenter.syncStatus.parked).toEqual([]);
		const seen: unknown[] = [];
		const stop = epicenter.subscribeSyncStatus((status) => {
			seen.push(status.parked);
		});
		stop();
		// Reachable before any attachment, which is the point: a parked address is
		// local state a caller must be able to see without a live session.
		expect(epicenter.syncStatus).toHaveProperty('parked');
	} finally {
		await epicenter[Symbol.asyncDispose]();
		rawDatabase.close();
	}
});

test('definitions reject invalid lens coordinates and structural field names', () => {
	expect(() =>
		defineLens({
			namespace: 'test',
			tables: { notes: defineTable({ fields: { title: field.string() } }) },
			values: {},
		}),
	).toThrow("Invalid namespace 'test'");
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {
				'not-valid': defineTable({ fields: { title: field.string() } }),
			},
			values: {},
		}),
	).toThrow("Invalid table name 'not-valid'");
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {},
			values: {
				'settings..sound': defineValue({ value: field.string() }),
			},
		}),
	).toThrow("Invalid value name 'settings..sound'");
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {
				Notes: defineTable({ fields: { title: field.string() } }),
				notes: defineTable({ fields: { title: field.string() } }),
			},
			values: {},
		}),
	).toThrow("Ambiguous table names 'Notes' and 'notes' differ only by case");
	expect(() =>
		defineTable({
			fields: {
				title: field.string(),
				Title: field.string(),
			},
		}),
	).toThrow("Ambiguous field names 'title' and 'Title' differ only by case");
	// A value name may carry dotted grouping, and case-differing value names are
	// two addresses rather than a collision: only table names become SQL
	// relations and only field names become columns, so only those two need the
	// case-insensitive rule (ADR-0178).
	expect(() =>
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {},
			values: {
				'settings.sound': defineValue({ value: field.string() }),
				'settings.sound.manualStart': defineValue({ value: field.boolean() }),
				'settings.Sound': defineValue({ value: field.string() }),
			},
		}),
	).not.toThrow();
	expect(() =>
		defineTable({
			// @ts-expect-error The runtime guard is exercised despite the type error.
			fields: { id: field.string() },
		}),
	).toThrow("structural 'id'");
});

test('Bun factory opens the public runtime over an in-memory path', async () => {
	await using epicenter = await openBunEpicenter({ path: ':memory:' });
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	const row = await notes.create({ title: 'factory', rank: 1 });
	expect(expectOk(await notes.get(row.id))).toEqual(row);
});

test('a table and value with the same local name do not collide', async () => {
	const { rawDatabase, epicenter } = setup();
	const bound = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: { notes: defineValue({ value: field.string() }) },
		}),
	);
	const row = await bound.tables.notes.create({ title: 'row', rank: 1 });
	await bound.values.notes.set('value');
	expect(expectOk(await bound.tables.notes.get(row.id))).toEqual(row);
	expect(expectOk(await bound.values.notes.get())).toBe('value');
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('table CRUD lowers undefined and scan returns stable row-ID order', async () => {
	const { rawDatabase, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	const localNotifications: string[][] = [];
	const unsubscribe = notes.subscribe((ids) => localNotifications.push(ids));
	const first = await notes.create({
		title: 'first',
		rank: 1,
		note: undefined,
	});
	const second = await notes.create({ title: 'second', rank: 1 });
	const third = await notes.create({ title: 'third', rank: 2, note: 'remove' });

	expect(first.id).toMatch(/^[a-z0-9]{24}$/);
	expect(expectOk(await notes.get(first.id))).toEqual({
		id: first.id,
		title: 'first',
		rank: 1,
	});
	expect(expectOk(await notes.update(third.id, { note: undefined }))).toEqual({
		id: third.id,
		title: 'third',
		rank: 2,
	});
	expect(
		expectOk(await notes.update('zzzzzzzzzzzzzzzzzzzzzzzz', { rank: 3 })),
	).toBeUndefined();

	const nullLabel = await notes.create({
		title: 'null label',
		rank: 3,
		label: null,
	});
	const scanned = await notes.scan();
	expect(scanned.nonconforming).toEqual([]);
	expect(scanned.rows.map(({ id }) => id)).toEqual(
		[first.id, second.id, third.id, nullLabel.id].sort(),
	);

	expect(await notes.delete(first.id)).toBe(true);
	expect(await notes.delete(first.id)).toBe(false);
	expect(expectOk(await notes.get(first.id))).toBeUndefined();
	expect(localNotifications).toEqual([
		[first.id],
		[second.id],
		[third.id],
		[third.id],
		[nullLabel.id],
		[first.id],
	]);
	unsubscribe();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('stored nonconforming rows and values are reported without repair', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	expectOk(
		replica.write({
			address: rowAddress(REMOTE_ROW_A),
			presence: 'present',
			set: { title: 42, rank: 1 },
			unset: [],
		}),
	);
	expectOk(
		replica.write({
			address: THEME_ADDRESS,
			presence: 'present',
			content: 42,
		}),
	);
	const bound = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: { theme: themeDefinition },
		}),
	);

	const rowError = expectErr(await bound.tables.notes.get(REMOTE_ROW_A));
	expect(rowError.name).toBe('NonconformingRow');
	expect(rowError).toMatchObject({
		id: REMOTE_ROW_A,
		issues: [{ field: 'title', kind: 'invalid' }],
	});
	const scanned = await bound.tables.notes.scan();
	expect(scanned.rows).toEqual([]);
	expect(scanned.nonconforming).toHaveLength(1);
	const entries = [];
	for await (const entry of bound.tables.notes.entries()) entries.push(entry);
	expect(entries).toHaveLength(1);
	const [entry] = entries;
	if (entry === undefined) throw new Error('Expected one table entry');
	expect(expectErr(entry)).toMatchObject({ id: REMOTE_ROW_A });
	expect(expectErr(await bound.values.theme.get()).name).toBe(
		'NonconformingValue',
	);
	expect(expectOk(replica.readRow(rowAddress(REMOTE_ROW_A)))).toEqual({
		title: 42,
		rank: 1,
	});

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('entries streams every classified row across internal batches', async () => {
	const { rawDatabase, replica, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	const ids = Array.from({ length: 105 }, (_, index) =>
		String(index).padStart(24, '0'),
	);
	for (const [rank, id] of ids.entries()) {
		expectOk(
			replica.write({
				address: rowAddress(id),
				presence: 'present',
				set: { title: `Note ${rank}`, rank },
				unset: [],
			}),
		);
	}

	const streamed = [];
	for await (const entry of notes.entries()) streamed.push(expectOk(entry));
	expect(streamed.map(({ id }) => id)).toEqual(ids);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('stopping entries early does not request another internal batch', async () => {
	let batchReads = 0;
	const methods = createTableReadMethods<typeof notesDefinition>(
		async (after) => {
			batchReads += 1;
			if (after !== undefined) throw new Error('Unexpected second batch');
			return {
				entries: [
					{
						data: { id: REMOTE_ROW_A, title: 'first', rank: 1 },
						error: null,
					},
				],
				nextAfter: REMOTE_ROW_A,
			};
		},
	);

	const iterator = methods.entries()[Symbol.asyncIterator]();
	expect((await iterator.next()).done).toBe(false);
	await iterator.return?.();
	expect(batchReads).toBe(1);
});

test('the current keyset batcher observes inserts ahead of its row-ID boundary, not behind it', async () => {
	// Adapter-mechanism coverage only: neither the batch size nor concurrent
	// insertion visibility is part of the public traversal contract.
	const { rawDatabase, replica, epicenter } = setup();
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	const initialIds = Array.from({ length: 101 }, (_, index) =>
		String(index + 100).padStart(24, '0'),
	);
	for (const [rank, id] of initialIds.entries()) {
		expectOk(
			replica.write({
				address: rowAddress(id),
				presence: 'present',
				set: { title: `Initial ${rank}`, rank },
				unset: [],
			}),
		);
	}

	const iterator = notes.entries()[Symbol.asyncIterator]();
	const firstBatch = [];
	for (let index = 0; index < 100; index += 1) {
		const next = await iterator.next();
		if (next.done) throw new Error('Traversal ended before the batch boundary');
		firstBatch.push(expectOk(next.value));
	}

	const behindBoundary = '000000000000000000000050';
	const aheadOfBoundary = '000000000000000000000300';
	for (const [rowId, title] of [
		[behindBoundary, 'Behind'],
		[aheadOfBoundary, 'Ahead'],
	] as const) {
		expectOk(
			replica.write({
				address: rowAddress(rowId),
				presence: 'present',
				set: { title, rank: 300 },
				unset: [],
			}),
		);
	}

	const remainder = [];
	while (true) {
		const next = await iterator.next();
		if (next.done) break;
		remainder.push(expectOk(next.value));
	}
	const lastInitialId = initialIds.at(-1);
	if (lastInitialId === undefined) throw new Error('Expected initial rows');

	expect(firstBatch.map(({ id }) => id)).toEqual(initialIds.slice(0, 100));
	expect(remainder.map(({ id }) => id)).toEqual([
		lastInitialId,
		aheadOfBoundary,
	]);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('value operations validate, unset to absence, and notify local commits', async () => {
	const { rawDatabase, epicenter } = setup();
	const theme = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: {},
			values: { theme: themeDefinition },
		}),
	).values.theme;
	let changes = 0;
	const unsubscribe = theme.subscribe(() => {
		changes += 1;
	});

	expect(expectOk(await theme.get())).toBeUndefined();
	await theme.set('dark');
	expect(expectOk(await theme.get())).toBe('dark');
	await expect(
		(theme.set as (value: unknown) => Promise<void>)(42),
	).rejects.toThrow('Invalid singleton value');
	await theme.unset();
	expect(expectOk(await theme.get())).toBeUndefined();
	expect(changes).toBe(2);
	unsubscribe();
	await theme.set('light');
	expect(changes).toBe(2);

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('throwing subscribers are logged without changing committed write results', async () => {
	const { sink, events } = memorySink();
	const { rawDatabase, epicenter } = setup(createLogger('test/data', sink));
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	let laterSubscriberCalls = 0;
	notes.subscribe(() => {
		throw new Error('subscriber failed');
	});
	notes.subscribe(() => {
		laterSubscriberCalls += 1;
	});

	const row = await notes.create({ title: 'committed', rank: 1 });
	expect(expectOk(await notes.get(row.id))).toEqual(row);
	expect(laterSubscriberCalls).toBe(1);
	expect(events).toHaveLength(1);
	expect(events[0]).toMatchObject({ level: 'error', source: 'test/data' });

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('subscriptions fire once per installed synchronized transaction', async () => {
	const { rawDatabase, epicenter } = setup();
	const authority = createScriptedAuthority();
	authority.applyRemote(
		[
			{
				presence: 'present',
				address: rowAddress(REMOTE_ROW_A),
				set: { title: 'A', rank: 1 },
				unset: [],
			},
			{
				presence: 'present',
				address: rowAddress(REMOTE_ROW_B),
				set: { title: 'B', rank: 2 },
				unset: [],
			},
			{
				presence: 'present',
				address: THEME_ADDRESS,
				content: 'remote',
			},
		],
		1,
	);
	const bound = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: { theme: themeDefinition },
		}),
	);
	const rowNotifications: string[][] = [];
	let valueNotifications = 0;
	bound.tables.notes.subscribe((ids) => rowNotifications.push(ids));
	bound.values.theme.subscribe(() => {
		valueNotifications += 1;
	});

	expectOk(
		await epicenter.attachSync({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
			transport: authority.transport,
		}),
	);
	await waitFor(() => valueNotifications === 1);
	expect(rowNotifications).toEqual([[REMOTE_ROW_A, REMOTE_ROW_B]]);
	expect(valueNotifications).toBe(1);
	expect(expectOk(await bound.values.theme.get())).toBe('remote');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('row documents persist across opens and settled deletion revokes live handles', async () => {
	const { rawDatabase, database, replica, epicenter } = setup();
	const authority = createScriptedAuthority();
	expectOk(
		replica.attach({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
		}),
	);
	expectOk(await replica.pullFacts(authority.transport));
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	const row = await notes.create({ title: 'document', rank: 1 });
	expectOk(await replica.pushSubmissions(authority.transport));
	const first = await notes.openDocument(row.id);
	first.get('content').insert(0, 'persisted');
	await first.whenDurable();
	await first[Symbol.asyncDispose]();

	const reopened = await notes.openDocument(row.id);
	expect(reopened.get('content').toString()).toBe('persisted');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', row.id],
		)[0]?.count,
	).toBe(1);
	expect(await notes.delete(row.id)).toBe(true);
	expectOk(await replica.pushSubmissions(authority.transport));
	expect(() => reopened.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', row.id],
		)[0]?.count,
	).toBe(0);
	await reopened[Symbol.asyncDispose]();
	await expect(notes.openDocument(row.id)).rejects.toThrow('absent row');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('settled deletion through an independently authored lens removes document bytes and revokes the other lens', async () => {
	const { rawDatabase, database, replica, epicenter } = setup();
	const authority = createScriptedAuthority();
	expectOk(
		replica.attach({
			deploymentId: 'https://example.com/',
			principalId: 'principal-a',
		}),
	);
	expectOk(await replica.pullFacts(authority.transport));
	const authorA = defineTable({
		fields: { title: field.string(), rank: field.integer() },
	});
	const authorB = defineTable({
		fields: { title: field.string() },
	});
	const lensA = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: authorA },
			values: {},
		}),
	).tables.notes;
	const lensB = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: authorB },
			values: {},
		}),
	).tables.notes;

	const row = await lensA.create({ title: 'shared', rank: 1 });
	expectOk(await replica.pushSubmissions(authority.transport));
	const document = await lensA.openDocument(row.id);
	document.get('content').insert(0, 'cross-lens');
	await document.whenDurable();

	expect(await lensB.delete(row.id)).toBe(true);
	expectOk(await replica.pushSubmissions(authority.transport));
	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', row.id],
		)[0]?.count,
	).toBe(0);
	await expect(lensB.openDocument(row.id)).rejects.toThrow('absent row');
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('installed synchronized deletion removes document bytes and revokes handles', async () => {
	const { rawDatabase, database, epicenter } = setup();
	const authority = createScriptedAuthority();
	authority.applyRemote(
		[
			{
				address: rowAddress(REMOTE_ROW_A),
				presence: 'present',
				set: { title: 'remote document', rank: 1 },
				unset: [],
			},
		],
		1,
	);
	const notes = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: {},
		}),
	).tables.notes;
	const session = {
		deploymentId: 'https://example.com/',
		principalId: 'principal-a',
	};
	expectOk(
		await epicenter.attachSync({
			...session,
			transport: authority.transport,
		}),
	);
	await waitFor(
		async () => expectOk(await notes.get(REMOTE_ROW_A)) !== undefined,
	);
	const document = await notes.openDocument(REMOTE_ROW_A);
	document.get('content').insert(0, 'remove me');
	authority.applyRemote(
		[
			{
				address: rowAddress(REMOTE_ROW_A),
				presence: 'absent',
			},
		],
		2,
	);
	expectOk(
		await epicenter.attachSync({
			...session,
			transport: authority.transport,
		}),
	);
	await waitFor(() => {
		try {
			document.get('content');
			return false;
		} catch {
			return true;
		}
	});

	expect(() => document.get('content')).toThrow('no longer live');
	expect(
		database.all<{ count: number }>(
			`SELECT COUNT(*) AS count FROM document_updates
			 WHERE namespace = ? AND table_name = ? AND row_id = ?`,
			[TEST_NAMESPACE, 'notes', REMOTE_ROW_A],
		)[0]?.count,
	).toBe(0);
	await document[Symbol.asyncDispose]();
	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('two borrowed lenses over one definition address the same stored state', async () => {
	const { rawDatabase, epicenter } = setup();
	const first = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: { theme: themeDefinition },
		}),
	);
	const second = epicenter.bind(
		defineLens({
			namespace: TEST_NAMESPACE,
			tables: { notes: notesDefinition },
			values: { theme: themeDefinition },
		}),
	);
	const row = await first.tables.notes.create({ title: 'shared', rank: 1 });
	await first.values.theme.set('shared');

	expect(expectOk(await second.tables.notes.get(row.id))).toEqual(row);
	expect(expectOk(await second.values.theme.get())).toBe('shared');

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});

test('lenses with different namespaces isolate the same table name', async () => {
	const { rawDatabase, epicenter } = setup();
	const first = epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.first',
			tables: { notes: notesDefinition },
			values: {},
		}),
	);
	const second = epicenter.bind(
		defineLens({
			namespace: 'so.epicenter.second',
			tables: { notes: notesDefinition },
			values: {},
		}),
	);
	const row = await first.tables.notes.create({ title: 'isolated', rank: 1 });

	expect(expectOk(await first.tables.notes.get(row.id))).toEqual(row);
	expect(expectOk(await second.tables.notes.get(row.id))).toBeUndefined();

	await epicenter[Symbol.asyncDispose]();
	rawDatabase.close();
});
