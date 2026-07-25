/**
 * Scalar V1 HTTP Synchronization Integration Tests
 *
 * Drives two file-backed production replica stores through the Bun authority
 * HTTP mount. This is the maintained executable proof that the split facts and
 * submissions routes preserve sealing, exact retries, reopen, and tombstones.
 *
 * Key behaviors:
 * - a local replacement seals, submits, retries identically, and converges
 * - a clean second replica installs the authority fact through the facts route
 * - a tombstone converges and remains dominant after every owner reopens
 */

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	type FactsResponse,
	SCALAR_SYNC_V1_LIMITS,
	type SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import { createBunSqliteAdapter } from '@epicenter/sqlite/bun';
import { Hono, type MiddlewareHandler } from 'hono';

import {
	openReplicaStore,
	type ReplicaStore,
} from '../../../data/src/store/replica/index.js';
import type { Env } from '../types.js';
import {
	createBunScalarV1Runtime,
	mountBunScalarV1App,
} from './scalar-v1-bun.js';
import {
	SCALAR_V1_FACTS_PATH,
	SCALAR_V1_SUBMISSIONS_PATH,
} from './scalar-v1-route.js';

const PRINCIPAL_ID = asPrincipalId('http-proof-principal');
const FIRST_REPLICA_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const SECOND_REPLICA_ID = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const ADDRESS = {
	namespace: 'so.epicenter.whispering',
	collection: 'recordings',
	recordKey: 'cccccccccccccccccccccccc',
} as const;

type OpenedReplica = {
	raw: Database;
	store: ReplicaStore;
};

function openReplica(path: string, replicaId?: string): OpenedReplica {
	const raw = new Database(path, { create: true, strict: true });
	try {
		return {
			raw,
			store: openReplicaStore({
				database: createBunSqliteAdapter(raw),
				limits: SCALAR_SYNC_V1_LIMITS,
				owner: null,
				...(replicaId === undefined ? {} : { initialize: { replicaId } }),
			}),
		};
	} catch (cause) {
		raw.close();
		throw cause;
	}
}

function openHttpAuthority(dir: string) {
	const runtime = createBunScalarV1Runtime({ dir });
	const app = new Hono<Env>();
	const auth: MiddlewareHandler<Env> = async (c, next) => {
		c.set('principal', { id: PRINCIPAL_ID });
		await next();
	};
	mountBunScalarV1App(app, {
		auth,
		runtime,
	});
	return { app, runtime };
}

async function readFacts(app: Hono<Env>, store: ReplicaStore) {
	const sync = store.sync();
	const url = new URL(`http://localhost${SCALAR_V1_FACTS_PATH}`);
	url.searchParams.set('afterSequence', String(sync.afterSequence));
	if (sync.authorityLifetime !== null) {
		url.searchParams.set('authorityLifetime', sync.authorityLifetime);
	}
	const request = {
		...(sync.authorityLifetime === null
			? {}
			: { authorityLifetime: sync.authorityLifetime }),
		afterSequence: sync.afterSequence,
	};
	const response = await app.request(url.toString());
	expect(response.status).toBe(200);
	const body = (await response.json()) as FactsResponse;
	store.installFacts({ request, response: body });
	return body;
}

function sealRequest(store: ReplicaStore): string {
	const outcome = store.seal();
	if (outcome.kind !== 'sealed') throw new Error('nothing to seal');
	return outcome.request.bytes;
}

async function submitExact(app: Hono<Env>, bytes: string) {
	const response = await app.request(SCALAR_V1_SUBMISSIONS_PATH, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: bytes,
	});
	expect(response.status).toBe(200);
	return (await response.json()) as SubmissionResponse;
}

test('two replicas converge through HTTP and retain tombstone dominance after retry and reopen', async () => {
	const root = mkdtempSync(join(tmpdir(), 'epicenter-scalar-v1-http-proof-'));
	const authorityDir = join(root, 'authority');
	const firstPath = join(root, 'first.sqlite');
	const secondPath = join(root, 'second.sqlite');
	let first = openReplica(firstPath, FIRST_REPLICA_ID);
	let second = openReplica(secondPath, SECOND_REPLICA_ID);
	let authority = openHttpAuthority(authorityDir);
	try {
		await readFacts(authority.app, first.store);
		await readFacts(authority.app, second.store);
		expect(first.store.sync().authorityLifetime).toBe(
			second.store.sync().authorityLifetime,
		);

		first.store.localWrite({
			address: ADDRESS,
			op: 'replace',
			value: { title: 'Replacement path' },
		});
		const createBytes = sealRequest(first.store);
		const createAccepted = await submitExact(authority.app, createBytes);
		expect(await submitExact(authority.app, createBytes)).toEqual(
			createAccepted,
		);
		first.store.settle(createAccepted);
		expect(first.store.record(ADDRESS)?.confirmed).toMatchObject({
			state: 'live',
			payload: { title: 'Replacement path' },
			sequence: 1,
		});

		await readFacts(authority.app, second.store);
		expect(second.store.record(ADDRESS)?.confirmed).toMatchObject({
			state: 'live',
			payload: { title: 'Replacement path' },
			sequence: 1,
		});

		first.store.localWrite({ address: ADDRESS, op: 'tombstone' });
		const tombstoneBytes = sealRequest(first.store);
		const tombstoneAccepted = await submitExact(authority.app, tombstoneBytes);
		expect(await submitExact(authority.app, tombstoneBytes)).toEqual(
			tombstoneAccepted,
		);
		first.store.settle(tombstoneAccepted);

		await readFacts(authority.app, second.store);
		expect(first.store.record(ADDRESS)?.confirmed).toMatchObject({
			state: 'tombstone',
			sequence: 2,
		});
		expect(second.store.record(ADDRESS)?.confirmed).toMatchObject({
			state: 'tombstone',
			sequence: 2,
		});

		first.raw.close();
		second.raw.close();
		await authority.runtime.close();
		first = openReplica(firstPath);
		second = openReplica(secondPath);
		authority = openHttpAuthority(authorityDir);

		expect(await submitExact(authority.app, tombstoneBytes)).toEqual(
			tombstoneAccepted,
		);
		await readFacts(authority.app, second.store);
		for (const replica of [first.store, second.store]) {
			expect(replica.record(ADDRESS)?.confirmed).toMatchObject({
				state: 'tombstone',
				sequence: 2,
			});
			expect(() =>
				replica.localWrite({
					address: ADDRESS,
					op: 'replace',
					value: { title: 'Cannot resurrect' },
				}),
			).toThrow('local write over a tombstone');
		}
	} finally {
		first.raw.close();
		second.raw.close();
		await authority.runtime.close();
		rmSync(root, { recursive: true, force: true });
	}
});
