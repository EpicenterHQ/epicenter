/**
 * Epicenter Sync Runtime Adapter Conformance Tests
 *
 * Drives the Bun runtime and Cloudflare Durable Object through the same scalar
 * V1 scenario and compares their protocol-visible outcomes.
 *
 * Key behaviors:
 * - Submissions settle and facts read from sequence zero
 * - Exact retries are idempotent while forks and gaps are typed refusals
 * - Lifetime mismatches are typed refusals for both operations
 * - Product-limit responses are valid and unpaged for this small scenario
 *
 * Neither adapter exposes authority limits, so byte paging remains covered by
 * `v1-authority.test.ts` rather than adding an adapter-only limits option.
 */
import { Database } from 'bun:sqlite';
import { expect, mock, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	type Intent,
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_V1_LIMITS,
	type SubmissionRequest,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { expectErr, expectOk } from 'wellcrafted/testing';
import { createBunEpicenterSyncRuntime } from './bun.js';
import type { EpicenterSyncV1Authority } from './v1-authority.js';

mock.module('cloudflare:workers', () => ({
	DurableObject: class {
		protected ctx: DurableObjectState;

		constructor(ctx: DurableObjectState, _env: Cloudflare.Env) {
			this.ctx = ctx;
		}
	},
}));

type SqlValue = ArrayBuffer | string | number | null;

const PRINCIPAL_ID = asPrincipalId('principal-a');
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const NAMESPACE = 'so.epicenter.tests';

const valueIntent = (content: string): Intent => ({
	address: {
		kind: 'value',
		namespace: NAMESPACE,
		valueName: 'theme',
	},
	presence: 'present',
	content,
});

function setupCloudflareStorage() {
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

type AdapterContext = {
	authority: EpicenterSyncV1Authority;
	cleanup(): void;
};

function setupBun(): AdapterContext {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-sync-conformance-bun-'));
	const runtime = createBunEpicenterSyncRuntime({ dir });
	return {
		authority: runtime.locateAuthority(PRINCIPAL_ID),
		cleanup() {
			runtime.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

async function setupCloudflare(): Promise<AdapterContext> {
	const { EpicenterAuthority } = await import('./cloudflare.js');
	const owned = setupCloudflareStorage();
	const state = {
		storage: owned.storage,
	} as unknown as DurableObjectState;
	return {
		authority: new EpicenterAuthority(state, {} as Cloudflare.Env),
		cleanup() {
			owned.database.close();
		},
	};
}

async function exerciseAdapter(authority: EpicenterSyncV1Authority) {
	const initial = expectOk(authority.readFacts({ afterSequence: 0 }));
	expectOk(parseFactsResponse(initial, SCALAR_V1_LIMITS));
	expect(initial).toMatchObject({ facts: [], hasMore: false });

	const request: SubmissionRequest = {
		authorityLifetime: initial.authorityLifetime,
		replicaId: REPLICA_ID,
		submissionNumber: 1,
		intents: [valueIntent('dark')],
	};
	const settled = expectOk(authority.submit(request));
	expectOk(parseSubmissionResponse(settled, SCALAR_V1_LIMITS));
	expect(settled).toMatchObject({
		authorityLifetime: initial.authorityLifetime,
		facts: [
			{
				sequence: 1,
				presence: 'present',
				content: 'dark',
			},
		],
		parked: [],
	});

	const facts = expectOk(
		authority.readFacts({
			authorityLifetime: initial.authorityLifetime,
			afterSequence: 0,
		}),
	);
	expectOk(parseFactsResponse(facts, SCALAR_V1_LIMITS));
	expect(facts).toMatchObject({
		authorityLifetime: initial.authorityLifetime,
		facts: settled.facts,
		hasMore: false,
	});

	const retry = expectOk(authority.submit(request));
	expectOk(parseSubmissionResponse(retry, SCALAR_V1_LIMITS));
	expect(retry).toEqual(settled);

	const fork = expectErr(
		authority.submit({
			...request,
			intents: [valueIntent('forked')],
		}),
	);
	expect(fork.name).toBe('SubmissionFork');

	const gap = expectErr(
		authority.submit({
			...request,
			submissionNumber: 3,
			intents: [valueIntent('gapped')],
		}),
	);
	expect(gap.name).toBe('SubmissionGap');

	const mismatchedFacts = expectErr(
		authority.readFacts({
			authorityLifetime: 'different-lifetime',
			afterSequence: 0,
		}),
	);
	expect(mismatchedFacts.name).toBe('LifetimeMismatch');
	const mismatchedSubmission = expectErr(
		authority.submit({
			...request,
			authorityLifetime: 'different-lifetime',
			submissionNumber: 2,
		}),
	);
	expect(mismatchedSubmission.name).toBe('LifetimeMismatch');

	return {
		initial: { ...initial, authorityLifetime: '<lifetime>' },
		settled: { ...settled, authorityLifetime: '<lifetime>' },
		facts: { ...facts, authorityLifetime: '<lifetime>' },
		retry: { ...retry, authorityLifetime: '<lifetime>' },
		refusals: [
			fork.name,
			gap.name,
			mismatchedFacts.name,
			mismatchedSubmission.name,
		],
	};
}

test('Bun and Cloudflare expose identical scalar V1 behavior', async () => {
	const adapters = [
		{ name: 'Bun', setup: setupBun },
		{ name: 'Cloudflare', setup: setupCloudflare },
	] as const;
	let reference: Awaited<ReturnType<typeof exerciseAdapter>> | undefined;

	for (const adapter of adapters) {
		const context = await adapter.setup();
		try {
			const observed = await exerciseAdapter(context.authority);
			if (reference === undefined) {
				reference = observed;
			} else {
				expect(observed, `${adapter.name} diverged from Bun`).toEqual(
					reference,
				);
			}
		} finally {
			context.cleanup();
		}
	}
});
