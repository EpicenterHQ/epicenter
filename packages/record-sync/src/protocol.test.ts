/**
 * Record Sync Protocol Tests
 *
 * Verifies exact wire parsing and the shared admission ceilings enforced before
 * any browser, Bun, or Durable Object SQLite adapter receives a mutation.
 *
 * Key behaviors:
 * - Closed request and response shapes reject malformed protocol values
 * - Mutation identifiers, collection counts, JSON depth, and bytes are bounded
 * - Nested finite JSON within the admission policy remains valid
 */

import { expect, test } from 'bun:test';
import { encodedBytes, RECORD_SYNC_ADMISSION_LIMITS } from './admission.js';
import {
	parseMutation,
	parsePullRequest,
	parsePullResponse,
	parsePushRequest,
	parsePushResponse,
	parseSnapshotChunkRequest,
	parseSnapshotChunkResponse,
	parseTablesApplyRequest,
	parseTablesApplyResponse,
	parseTablesStateRequest,
	parseTablesStateResponse,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from './protocol.js';

const envelope = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	recordsEpoch: 'epoch-1',
};

test('protocol parsers accept the closed wire shapes and nested JSON cells', () => {
	expect(
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'createRow',
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'one' },
				},
			],
		}),
	).toMatchObject({ actorId: 'actor-a', actorSequence: 1 });
	expect(
		parsePushRequest({
			kind: 'push',
			...envelope,
			mutations: [
				{
					actorId: 'actor-a',
					actorSequence: 1,
					operations: [
						{
							kind: 'updateRow',
							table: 'notes',
							rowId: 'n1',
							cells: { metadata: { tags: ['one', 'two'], rank: 2 } },
						},
					],
				},
			],
		}).mutations[0]?.actorId,
	).toBe('actor-a');
	expect(
		parsePullRequest({ kind: 'pull', ...envelope, cursor: 0, limit: 100 }),
	).toMatchObject({ cursor: 0, limit: 100 });
	expect(
		parseSnapshotChunkRequest({
			kind: 'snapshotChunk',
			...envelope,
			generation: 1,
			index: 0,
		}),
	).toMatchObject({ generation: 1, index: 0 });
});

test('tables state and apply parsers keep review and admission shapes closed', () => {
	expect(parseTablesStateRequest({ ...envelope, kind: 'tablesState' })).toEqual(
		{ ...envelope, kind: 'tablesState' },
	);
	expect(
		parseTablesStateResponse({
			kind: 'tablesState',
			ok: true,
			head: 3,
			rows: [{ table: 'notes', rowId: 'n1', cells: { title: 'One' } }],
		}),
	).toMatchObject({ ok: true, head: 3 });
	expect(
		parseTablesApplyRequest({
			...envelope,
			kind: 'tablesApply',
			expectedHead: 3,
			operations: [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: { title: 'Two' },
				},
			],
		}),
	).toMatchObject({ expectedHead: 3 });
	expect(
		parseTablesApplyResponse({
			kind: 'tablesApply',
			ok: false,
			reason: 'head-moved',
		}),
	).toMatchObject({ ok: false, reason: 'head-moved' });
	expect(() =>
		parseTablesApplyRequest({
			...envelope,
			kind: 'tablesApply',
			expectedHead: 3,
			operations: [],
		}),
	).toThrow('Invalid tables apply request');
});

test('mutation parser rejects malformed durable outbox values', () => {
	expect(() =>
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: { score: Number.NaN },
				},
			],
		}),
	).toThrow('Invalid record-sync mutation');
});

test('response parsers validate both success and refusal variants', () => {
	expect(parsePushResponse({ kind: 'push', ok: true })).toEqual({
		kind: 'push',
		ok: true,
	});
	expect(
		parsePushResponse({ kind: 'push', ok: false, reason: 'create-conflict' }),
	).toMatchObject({ ok: false, reason: 'create-conflict' });
	expect(
		parsePullResponse({
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: 0,
			mutations: [
				{
					serverSequence: 1,
					actorId: 'actor-a',
					actorSequence: 1,
					operations: [
						{
							kind: 'updateRow',
							table: 'notes',
							rowId: 'n1',
							cells: { metadata: { tags: ['one'] } },
						},
					],
				},
			],
			newCursor: 1,
			hasMore: false,
		}),
	).toMatchObject({ newCursor: 1 });
	expect(
		parseSnapshotChunkResponse({
			kind: 'snapshotChunk',
			ok: false,
			reason: 'snapshot-replaced',
		}),
	).toMatchObject({ ok: false, reason: 'snapshot-replaced' });
});

test('response parsers reject extra fields and tombstone-era snapshot rows', () => {
	expect(() =>
		parsePushResponse({ kind: 'push', ok: true, acceptedThrough: 3 }),
	).toThrow();
	// Snapshots carry live rows only; the removed `deleted` flag is now an
	// unknown extra property on the closed row shape.
	expect(() =>
		parseSnapshotChunkResponse({
			kind: 'snapshotChunk',
			ok: true,
			chunk: {
				generation: 1,
				index: 0,
				rows: [
					{
						table: 'notes',
						rowId: 'n1',
						deleted: true,
						cells: {},
					},
				],
				checksum: 'checksum',
			},
		}),
	).toThrow();
});

test('push parsing rejects non-JSON cells, unsafe sequences, and extra keys', () => {
	const operation = {
		kind: 'updateRow',
		table: 'notes',
		rowId: 'n1',
		cells: { title: 'valid' },
	};
	const mutation = {
		actorId: 'actor-a',
		actorSequence: 1,
		operations: [operation],
	};
	const base = {
		kind: 'push',
		...envelope,
		mutations: [mutation],
	};
	expect(() =>
		parsePushRequest({ ...base, mutations: [], extra: true }),
	).toThrow();
	expect(() =>
		parsePushRequest({ ...base, recordsSchemaHash: 'obsolete-duplicate' }),
	).toThrow();
	expect(() =>
		parsePushRequest({
			...base,
			mutations: [
				{
					...mutation,
					actorSequence: Number.MAX_SAFE_INTEGER + 1,
				},
			],
		}),
	).toThrow();
	expect(() =>
		parsePushRequest({
			...base,
			mutations: [
				{
					...mutation,
					operations: [
						{
							...operation,
							cells: { invalid: undefined },
						},
					],
				},
			],
		}),
	).toThrow();
});

test('mutation parsing rejects identifiers over the UTF-8 byte ceiling', () => {
	const oversizedUnicodeId = '😀'.repeat(
		Math.floor(RECORD_SYNC_ADMISSION_LIMITS.identifierBytes / 4) + 1,
	);
	expect(() =>
		parseMutation({
			actorId: oversizedUnicodeId,
			actorSequence: 1,
			operations: [
				{
					kind: 'deleteRow',
					table: 'notes',
					rowId: 'n1',
				},
			],
		}),
	).toThrow('Invalid record-sync mutation');
});

test('mutation parsing rejects operation and cell counts over their ceilings', () => {
	const deletion = {
		kind: 'deleteRow' as const,
		table: 'notes',
		rowId: 'n1',
	};
	expect(() =>
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: Array.from(
				{
					length: RECORD_SYNC_ADMISSION_LIMITS.operationsPerMutation + 1,
				},
				() => deletion,
			),
		}),
	).toThrow('Invalid record-sync mutation');
	expect(() =>
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: Object.fromEntries(
						Array.from(
							{
								length: RECORD_SYNC_ADMISSION_LIMITS.cellsPerOperation + 1,
							},
							(_, index) => [`field-${index}`, index],
						),
					),
				},
			],
		}),
	).toThrow('Invalid record-sync mutation');
});

test('push parsing rejects mutation batches over the admission ceiling', () => {
	const mutation = {
		actorId: 'actor-a',
		actorSequence: 1,
		operations: [
			{
				kind: 'deleteRow' as const,
				table: 'notes',
				rowId: 'n1',
			},
		],
	};
	expect(() =>
		parsePushRequest({
			kind: 'push',
			...envelope,
			mutations: Array.from(
				{ length: RECORD_SYNC_ADMISSION_LIMITS.mutationsPerPush + 1 },
				(_, index) => ({ ...mutation, actorSequence: index + 1 }),
			),
		}),
	).toThrow('Invalid record-sync push request');
});

test('mutation parsing rejects JSON deeper than the admission ceiling', () => {
	let nested: unknown = 'leaf';
	for (
		let depth = 0;
		depth <= RECORD_SYNC_ADMISSION_LIMITS.jsonDepth;
		depth += 1
	) {
		nested = [nested];
	}
	expect(() =>
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: { metadata: nested },
				},
			],
		}),
	).toThrow('Invalid record-sync mutation');
});

test('cell admission counts ASCII and multibyte UTF-8 at the exact boundary', () => {
	const parseBody = (body: string) =>
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: { body },
				},
			],
		});
	const limit = RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes;

	expect(parseBody('x'.repeat(limit))).toBeDefined();
	expect(() => parseBody('x'.repeat(limit + 1))).toThrow(
		'Invalid record-sync mutation',
	);
	expect(parseBody('😀'.repeat(limit / 4))).toBeDefined();
	expect(() => parseBody(`${'😀'.repeat(limit / 4)}a`)).toThrow(
		'Invalid record-sync mutation',
	);
});

test('mutation admission accepts the exact byte ceiling and rejects one-byte overflow', () => {
	const firstBody = 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes);
	const base = {
		actorId: 'actor-a',
		actorSequence: 1,
		operations: [
			{
				kind: 'updateRow' as const,
				table: 'notes',
				rowId: 'n1',
				cells: { body: firstBody },
			},
			{
				kind: 'updateRow' as const,
				table: 'notes',
				rowId: 'n2',
				cells: { body: '' },
			},
		],
	};
	const remaining =
		RECORD_SYNC_ADMISSION_LIMITS.encodedMutationBytes -
		encodedBytes(JSON.stringify(base));
	const exact = {
		...base,
		operations: [
			base.operations[0]!,
			{ ...base.operations[1]!, cells: { body: 'x'.repeat(remaining) } },
		],
	};

	expect(encodedBytes(JSON.stringify(exact))).toBe(
		RECORD_SYNC_ADMISSION_LIMITS.encodedMutationBytes,
	);
	expect(parseMutation(exact)).toBeDefined();
	expect(
		parsePullResponse({
			kind: 'pull',
			ok: true,
			snapshotRequired: false,
			fromCursor: 0,
			newCursor: 1,
			hasMore: false,
			mutations: [{ ...exact, serverSequence: 1 }],
		}),
	).toBeDefined();
	expect(() =>
		parseMutation({
			...exact,
			operations: [
				exact.operations[0]!,
				{
					...exact.operations[1]!,
					cells: { body: `${exact.operations[1]!.cells.body}x` },
				},
			],
		}),
	).toThrow('Invalid record-sync mutation');
});

test('snapshot parsing rejects a cell or accumulated row over its byte ceiling', () => {
	const response = (cells: Record<string, string>) => ({
		kind: 'snapshotChunk' as const,
		ok: true as const,
		chunk: {
			generation: 1,
			index: 0,
			rows: [{ table: 'notes', rowId: 'n1', cells }],
			checksum: 'checksum',
		},
	});

	expect(() =>
		parseSnapshotChunkResponse(
			response({
				body: 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes + 1),
			}),
		),
	).toThrow('Invalid record-sync snapshot chunk response');
	expect(() =>
		parseSnapshotChunkResponse(
			response({
				one: 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes),
				two: 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes),
			}),
		),
	).toThrow('Invalid record-sync snapshot chunk response');
});

test('snapshot parsing accepts the exact chunk ceiling and rejects one-byte overflow', () => {
	const firstBody = 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedCellBytes);
	const baseChunk = {
		generation: 1,
		index: 0,
		rows: [
			{ table: 'notes', rowId: 'n1', cells: { body: firstBody } },
			{ table: 'notes', rowId: 'n2', cells: { body: '' } },
		],
		checksum: 'checksum',
	};
	const remaining =
		RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes -
		encodedBytes(JSON.stringify(baseChunk));
	const exactChunk = {
		...baseChunk,
		rows: [
			baseChunk.rows[0]!,
			{
				...baseChunk.rows[1]!,
				cells: { body: 'x'.repeat(remaining) },
			},
		],
	};
	const response = (chunk: typeof exactChunk) => ({
		kind: 'snapshotChunk' as const,
		ok: true as const,
		chunk,
	});

	expect(encodedBytes(JSON.stringify(exactChunk))).toBe(
		RECORD_SYNC_ADMISSION_LIMITS.encodedSnapshotChunkBytes,
	);
	expect(parseSnapshotChunkResponse(response(exactChunk))).toBeDefined();
	expect(() =>
		parseSnapshotChunkResponse(
			response({
				...exactChunk,
				rows: [
					exactChunk.rows[0]!,
					{
						...exactChunk.rows[1]!,
						cells: { body: `${exactChunk.rows[1]!.cells.body}x` },
					},
				],
			}),
		),
	).toThrow('Invalid record-sync snapshot chunk response');
});

test('mutation parsing rejects encoded mutations over the byte ceiling', () => {
	expect(() =>
		parseMutation({
			actorId: 'actor-a',
			actorSequence: 1,
			operations: [
				{
					kind: 'updateRow',
					table: 'notes',
					rowId: 'n1',
					cells: {
						body: 'x'.repeat(RECORD_SYNC_ADMISSION_LIMITS.encodedMutationBytes),
					},
				},
			],
		}),
	).toThrow('Invalid record-sync mutation');
});

test('push parsing rejects aggregate bytes below the HTTP request ceiling', () => {
	const body = 'x'.repeat(60 * 1024);
	expect(() =>
		parsePushRequest({
			kind: 'push',
			...envelope,
			mutations: Array.from({ length: 13 }, (_, index) => ({
				actorId: 'actor-a',
				actorSequence: index + 1,
				operations: [
					{
						kind: 'updateRow',
						table: 'notes',
						rowId: `n${index}`,
						cells: { body },
					},
				],
			})),
		}),
	).toThrow('Invalid record-sync push request');
});
