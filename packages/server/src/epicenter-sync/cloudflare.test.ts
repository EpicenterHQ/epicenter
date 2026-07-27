/**
 * Cloudflare Epicenter Authority Tests
 *
 * Verifies the Durable Object authority through its typed RPC surface using a
 * fake SQLite-backed Durable Object storage implementation.
 *
 * Key behaviors:
 * - Scalar submissions and fact reads execute through separate RPC methods
 * - Accepted state, retry state, and the lifetime survive actor restart
 */
import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';

import { Principal } from '@epicenter/auth';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import type { Env } from '../types.js';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: DurableObjectState;

		constructor(ctx: DurableObjectState, _env: Cloudflare.Env) {
			this.ctx = ctx;
		}
	},
}));

type SqlValue = ArrayBuffer | string | number | null;

function setupStorage() {
	const database = new Database(':memory:', { strict: true });
	let alarm: number | null = null;
	const storage = {
		sql: {
			get databaseSize() {
				return 0;
			},
			exec<TRow extends Record<string, SqlValue>>(
				sql: string,
				...bindings: SqlValue[]
			) {
				const statements = sql.split(';').filter((part) => part.trim());
				if (statements.length > 1) {
					database.exec(sql);
					return { toArray: () => [] as TRow[] };
				}
				const values = bindings.map((value) =>
					value instanceof ArrayBuffer ? new Uint8Array(value) : value,
				);
				const query = database.query<
					TRow,
					(string | number | null | Uint8Array)[]
				>(sql);
				if (/^\s*(SELECT|WITH|PRAGMA)\b/i.test(sql)) {
					return { toArray: () => query.all(...values) };
				}
				query.run(...values);
				return { toArray: () => [] as TRow[] };
			},
		},
		transactionSync<TResult>(run: () => TResult): TResult {
			return database.transaction(run).immediate();
		},
		getAlarm: async () => alarm,
		setAlarm: async (value: number) => {
			alarm = value;
		},
		deleteAlarm: async () => {
			alarm = null;
		},
	} as unknown as DurableObjectStorage;
	return { database, storage };
}

function requestBody(authorityLifetime: string) {
	const intents = [
		{
			address: {
				kind: 'row' as const,
				namespace: 'so.epicenter.tests',
				tableName: 'rows',
				rowId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
			},
			presence: 'present' as const,
			set: { title: 'Persisted' },
			unset: [],
		},
	];
	return {
		authorityLifetime,
		replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
		submissionNumber: 1,
		intents,
	};
}

test('lifetime, settled facts, and exact retries survive Durable Object restart', async () => {
	const { EpicenterAuthority } = await import('./cloudflare.js');
	const owned = setupStorage();
	const state = {
		storage: owned.storage,
	} as unknown as DurableObjectState;
	try {
		let authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const initialPage = expectOk(authority.readFacts({ afterSequence: 0 }));
		expectOk(parseFactsResponse(initialPage, SCALAR_V1_LIMITS));
		const request = requestBody(initialPage.authorityLifetime);
		const settled = expectOk(authority.submit(request));
		expectOk(parseSubmissionResponse(settled, SCALAR_V1_LIMITS));
		expect(settled).toMatchObject({
			authorityLifetime: initialPage.authorityLifetime,
			facts: [{ sequence: 1, fields: { title: 'Persisted' } }],
			parked: [],
		});

		authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const reopenedPage = expectOk(authority.readFacts({ afterSequence: 0 }));
		expectOk(parseFactsResponse(reopenedPage, SCALAR_V1_LIMITS));
		expect(reopenedPage).toMatchObject({
			authorityLifetime: initialPage.authorityLifetime,
			hasMore: false,
			facts: [
				{
					sequence: 1,
					presence: 'present',
					fields: { title: 'Persisted' },
				},
			],
		});
		const retry = expectOk(authority.submit(request));
		expectOk(parseSubmissionResponse(retry, SCALAR_V1_LIMITS));
		expect(retry).toEqual(settled);
	} finally {
		owned.database.close();
	}
});

test('mounted routes await the two Durable Object RPC methods', async () => {
	const { EpicenterAuthority, mountCloudflareEpicenterSyncApp } = await import(
		'./cloudflare.js'
	);
	const owned = setupStorage();
	const state = {
		storage: owned.storage,
	} as unknown as DurableObjectState;
	try {
		const authority = new EpicenterAuthority(state, {} as Cloudflare.Env);
		const app = new Hono<Env>();
		mountCloudflareEpicenterSyncApp(app, {
			auth: async (c, next) => {
				c.set('principal', Principal.assert({ id: asPrincipalId('alice') }));
				await next();
			},
			resolveNamespace: () => ({
				getByName: () => ({
					readFacts: async (request: unknown) => authority.readFacts(request),
					submit: async (request: unknown) => authority.submit(request),
				}),
			}),
		});

		const initial = await app.request('/api/sync/v1/facts?afterSequence=0');
		expect(initial.status).toBe(200);
		const page = expectOk(
			parseFactsResponse(await initial.json(), SCALAR_V1_LIMITS),
		);

		const settled = await app.request('/api/sync/v1/submissions', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify(requestBody(page.authorityLifetime)),
		});
		expect(settled.status).toBe(200);
		expectOk(parseSubmissionResponse(await settled.json(), SCALAR_V1_LIMITS));
	} finally {
		owned.database.close();
	}
});
