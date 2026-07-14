/**
 * Records Route Tests
 *
 * Verifies the authenticated HTTP projection of the logical record authority.
 * The route owns exact request parsing and derives the durable partition from
 * server-side auth rather than accepting a principal from a client.
 *
 * Key behaviors:
 * - Authenticated principal and path workspace select the backend partition
 * - Malformed and structurally inexact JSON is rejected before the backend
 * - Open, push, and pull preserve the record-sync protocol responses
 */

import { expect, test } from 'bun:test';
import { asPrincipalId } from '@epicenter/identity';
import {
	type PullRequest,
	type PushRequest,
	RECORD_SYNC_PROTOCOL_MAJOR,
} from '@epicenter/record-sync';
import { Hono } from 'hono';
import type { Records, RecordsPartition } from '../records/contracts.js';
import type { Env } from '../types.js';
import { mountRecordsApp } from './records.js';

function setup() {
	const partitions: RecordsPartition[] = [];
	const records: Records = {
		async open(partition) {
			partitions.push(partition);
			return {
				ok: true,
				recordsEpoch: 'epoch-1',
				recordsDescriptor: 'schema descriptor 1',
				recordsSchemaHash: 'schema-1',
			};
		},
		async push(partition) {
			partitions.push(partition);
			return { kind: 'push', ok: true };
		},
		async pull(partition, request) {
			partitions.push(partition);
			return {
				kind: 'pull',
				ok: true,
				snapshotRequired: false,
				fromCursor: request.cursor,
				mutations: [],
				newCursor: request.cursor,
				hasMore: false,
			};
		},
		async snapshotChunk() {
			return {
				kind: 'snapshotChunk',
				ok: false,
				reason: 'snapshot-replaced',
			};
		},
		async readTablesState(partition) {
			partitions.push(partition);
			return { kind: 'tablesState', ok: true, head: 4, rows: [] };
		},
		async applyTables(partition) {
			partitions.push(partition);
			return { kind: 'tablesApply', ok: true, newHead: 5 };
		},
	};
	const app = new Hono<Env>();
	mountRecordsApp(app, {
		resolveRecords: () => records,
		auth: async (c, next) => {
			c.set('principal', { id: asPrincipalId('authenticated-alice') });
			await next();
		},
	});
	return { app, partitions };
}

const envelope = {
	protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
	recordsEpoch: 'epoch-1',
};

function post(
	app: Hono<Env>,
	suffix: string,
	body: unknown,
): Promise<Response> {
	return Promise.resolve(
		app.request(`/api/records/wiki/${suffix}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(body),
		}),
	);
}

test('open stamps the authenticated principal and path workspace onto the backend call', async () => {
	const { app, partitions } = setup();
	const response = await post(app, 'open', {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		recordsDescriptor: 'schema descriptor 1',
		recordsSchemaHash: 'schema-1',
	});

	expect(response.status).toBe(200);
	expect((await response.json()) as unknown).toEqual({
		recordsEpoch: 'epoch-1',
		recordsDescriptor: 'schema descriptor 1',
		recordsSchemaHash: 'schema-1',
	});
	expect(partitions).toEqual([
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
	]);
});

test('open rejects extra client-owned partition fields', async () => {
	const { app, partitions } = setup();
	const response = await post(app, 'open', {
		protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
		recordsSchemaHash: 'schema-1',
		principalId: 'mallory',
	});

	expect(response.status).toBe(400);
	expect((await response.json()) as { error: { name: string } }).toMatchObject({
		error: { name: 'InvalidRequest' },
	});
	expect(partitions).toEqual([]);
});

test('malformed JSON is rejected before the records backend', async () => {
	const { app, partitions } = setup();
	const response = await app.request('/api/records/wiki/push', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: '{',
	});

	expect(response.status).toBe(400);
	expect(partitions).toEqual([]);
});

test('oversized JSON is rejected before parsing or backend work', async () => {
	const { app, partitions } = setup();
	const response = await app.request('/api/records/wiki/push', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ payload: 'x'.repeat(1_048_576) }),
	});

	expect(response.status).toBe(413);
	expect((await response.json()) as { error: { name: string } }).toMatchObject({
		error: { name: 'RequestTooLarge' },
	});
	expect(partitions).toEqual([]);
});

test('oversized workspace identity is rejected before backend work', async () => {
	const { app, partitions } = setup();
	const response = await app.request(`/api/records/${'w'.repeat(513)}/open`, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({
			protocolMajor: RECORD_SYNC_PROTOCOL_MAJOR,
			recordsSchemaHash: 'schema-1',
		}),
	});

	expect(response.status).toBe(400);
	expect(partitions).toEqual([]);
});

test('push and pull parse exact protocol requests and return backend responses', async () => {
	const { app, partitions } = setup();
	const push: PushRequest = {
		...envelope,
		kind: 'push',
		mutations: [
			{
				actorId: 'actor-1',
				actorSequence: 1,
				operations: [
					{
						kind: 'createRow',
						table: 'pages',
						rowId: 'page-1',
						cells: { title: 'Hello' },
					},
				],
			},
		],
	};
	const pull: PullRequest = {
		...envelope,
		kind: 'pull',
		cursor: 0,
		limit: 100,
	};

	const pushResponse = await post(app, 'push', push);
	const pullResponse = await post(app, 'pull', pull);

	expect((await pushResponse.json()) as unknown).toEqual({
		kind: 'push',
		ok: true,
	});
	expect((await pullResponse.json()) as unknown).toEqual({
		kind: 'pull',
		ok: true,
		snapshotRequired: false,
		fromCursor: 0,
		mutations: [],
		newCursor: 0,
		hasMore: false,
	});
	expect(partitions).toEqual([
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
	]);
});

test('tables apply is an authenticated expected-head authority transition', async () => {
	const { app, partitions } = setup();
	const stateResponse = await post(app, 'tables-state', {
		...envelope,
		kind: 'tablesState',
	});
	const applyResponse = await post(app, 'tables-apply', {
		...envelope,
		kind: 'tablesApply',
		expectedHead: 4,
		operations: [
			{
				kind: 'updateRow',
				table: 'pages',
				rowId: 'page-1',
				cells: { title: 'Reviewed' },
			},
		],
	});

	expect((await stateResponse.json()) as unknown).toEqual({
		kind: 'tablesState',
		ok: true,
		head: 4,
		rows: [],
	});
	expect((await applyResponse.json()) as unknown).toEqual({
		kind: 'tablesApply',
		ok: true,
		newHead: 5,
	});
	expect(partitions).toEqual([
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
		{
			principalId: asPrincipalId('authenticated-alice'),
			workspaceId: 'wiki',
		},
	]);
});
