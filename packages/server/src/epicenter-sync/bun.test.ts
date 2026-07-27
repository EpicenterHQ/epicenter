/**
 * Bun Epicenter Sync Composition Tests
 *
 * Verifies the mounted Bun runtime across authentication, scalar V1 operations,
 * and document publish/pull boundaries with one principal-owned SQLite authority.
 *
 * Key behaviors:
 * - Missing bearer credentials never reach the scalar or document authority
 * - A scalar submission settles and appears in the facts feed
 * - Reopening a principal store preserves its authority lifetime
 * - Document publish and conditional pull share one bearer-authenticated route
 */
import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Principal } from '@epicenter/auth';
import type { Intent } from '@epicenter/data/protocol/v1';
import {
	parseFactsResponse,
	parseSubmissionResponse,
	SCALAR_V1_LIMITS,
} from '@epicenter/data/protocol/v1';
import { asPrincipalId } from '@epicenter/identity';
import * as Y from '@y/y';
import { Hono } from 'hono';
import { expectOk } from 'wellcrafted/testing';

import type { Env } from '../types.js';
import {
	createBunEpicenterSyncRuntime,
	mountBunEpicenterSyncApp,
} from './bun.js';

const PRINCIPAL_ID = asPrincipalId('alice');
const NAMESPACE = 'so.epicenter.tests';
const TABLE = 'documents';
const ROW_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const REPLICA_ID = 'rrrrrrrrrrrrrrrrrrrrrrrr';
const ROW_ADDRESS = {
	kind: 'row',
	namespace: NAMESPACE,
	tableName: TABLE,
	rowId: ROW_ID,
} as const;

function setup() {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-sync-bun-route-'));
	const runtime = createBunEpicenterSyncRuntime({ dir });
	const app = new Hono<Env>();
	mountBunEpicenterSyncApp(app, {
		runtime,
		auth: async (c, next) => {
			if (c.req.header('authorization') !== 'Bearer token') {
				return new Response(null, { status: 401 });
			}
			c.set('principal', Principal.assert({ id: PRINCIPAL_ID }));
			await next();
		},
	});
	return {
		app,
		dir,
		runtime,
		cleanup() {
			runtime.close();
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

function readFacts(app: Hono<Env>, authenticated = true) {
	return app.request('/api/sync/v1/facts?afterSequence=0', {
		headers: authenticated ? { authorization: 'Bearer token' } : {},
	});
}

function submit(app: Hono<Env>, body: unknown, authenticated = true) {
	return app.request('/api/sync/v1/submissions', {
		method: 'POST',
		headers: {
			'content-type': 'application/json',
			...(authenticated ? { authorization: 'Bearer token' } : {}),
		},
		body: JSON.stringify(body),
	});
}

async function submitSuccessfully(app: Hono<Env>, body: unknown) {
	const response = await submit(app, body);
	expect(response.status).toBe(200);
	return expectOk(
		parseSubmissionResponse(await response.json(), SCALAR_V1_LIMITS),
	);
}

function createRequest(authorityLifetime: string, submissionNumber = 1) {
	const intents: Intent[] = [
		{
			address: ROW_ADDRESS,
			presence: 'present',
			set: { title: 'Hello' },
			unset: [],
		},
	];
	return {
		authorityLifetime,
		replicaId: REPLICA_ID,
		submissionNumber,
		intents,
	};
}

async function readLifetime(app: Hono<Env>): Promise<string> {
	const response = await readFacts(app);
	expect(response.status).toBe(200);
	return expectOk(parseFactsResponse(await response.json(), SCALAR_V1_LIMITS))
		.authorityLifetime;
}

function documentPath(): string {
	return `/api/sync/v1/documents/${NAMESPACE}/${TABLE}/${ROW_ID}`;
}

function encodeContent(text: string): Uint8Array {
	const authored = new Y.Doc();
	try {
		authored.get('content').insert(0, text);
		return new Uint8Array(Y.encodeStateAsUpdateV2(authored));
	} finally {
		authored.destroy();
	}
}

test('missing bearer refuses the scalar operations and document routes', async () => {
	const context = setup();
	try {
		expect((await readFacts(context.app, false)).status).toBe(401);
		expect((await submit(context.app, {}, false)).status).toBe(401);
		const publish = await context.app.request(documentPath(), {
			method: 'POST',
			body: encodeContent('nope').slice().buffer as ArrayBuffer,
		});
		expect(publish.status).toBe(401);
		const pull = await context.app.request(documentPath());
		expect(pull.status).toBe(401);
	} finally {
		context.cleanup();
	}
});

test('mounted submission stores one principal row returned by facts', async () => {
	const context = setup();
	try {
		const lifetime = await readLifetime(context.app);
		const submissionResponse = await submitSuccessfully(
			context.app,
			createRequest(lifetime),
		);
		expect(submissionResponse).toMatchObject({
			authorityLifetime: lifetime,
			facts: [
				{
					sequence: 1,
					presence: 'present',
					address: ROW_ADDRESS,
					fields: { title: 'Hello' },
				},
			],
			parked: [],
		});

		const page = expectOk(
			parseFactsResponse(
				await (await readFacts(context.app)).json(),
				SCALAR_V1_LIMITS,
			),
		);
		expect(page).toMatchObject({
			authorityLifetime: lifetime,
			facts: submissionResponse.facts,
			hasMore: false,
		});
	} finally {
		context.cleanup();
	}
});

test('reopening the same principal file preserves its authority lifetime', () => {
	const dir = mkdtempSync(join(tmpdir(), 'epicenter-sync-bun-lifetime-'));
	let runtime = createBunEpicenterSyncRuntime({ dir });
	try {
		const first = expectOk(
			runtime.locateAuthority(PRINCIPAL_ID).readFacts({ afterSequence: 0 }),
		).authorityLifetime;
		runtime.close();

		runtime = createBunEpicenterSyncRuntime({ dir });
		const reopened = expectOk(
			runtime.locateAuthority(PRINCIPAL_ID).readFacts({ afterSequence: 0 }),
		).authorityLifetime;
		runtime.close();
		expect(reopened).toBe(first);
	} finally {
		runtime.close();
		rmSync(dir, { recursive: true, force: true });
	}
});

test('publish then conditional pull round-trips through the mounted routes', async () => {
	const context = setup();
	try {
		const lifetime = await readLifetime(context.app);
		await submitSuccessfully(context.app, createRequest(lifetime));
		const published = await context.app.request(documentPath(), {
			method: 'POST',
			headers: { authorization: 'Bearer token' },
			body: encodeContent('published body').slice().buffer as ArrayBuffer,
		});
		expect(published.status).toBe(200);
		expect((await published.json()) as unknown).toEqual({
			outcome: 'accepted',
		});

		const pulled = await context.app.request(documentPath(), {
			headers: { authorization: 'Bearer token' },
		});
		expect(pulled.status).toBe(200);
		const version = pulled.headers.get('etag');
		expect(version).toMatch(/^"\d+"$/);
		const state = new Uint8Array(await pulled.arrayBuffer());
		const hydrated = new Y.Doc();
		try {
			Y.applyUpdateV2(hydrated, state);
			expect(hydrated.get('content').toString()).toBe('published body');
		} finally {
			hydrated.destroy();
		}

		// The matching version transfers no body.
		const unchanged = await context.app.request(documentPath(), {
			headers: {
				authorization: 'Bearer token',
				'if-none-match': version ?? '',
			},
		});
		expect(unchanged.status).toBe(304);
	} finally {
		context.cleanup();
	}
});

test('pulling a deleted row reports not-live', async () => {
	const context = setup();
	try {
		const lifetime = await readLifetime(context.app);
		await submitSuccessfully(context.app, createRequest(lifetime));
		await submitSuccessfully(context.app, {
			authorityLifetime: lifetime,
			replicaId: REPLICA_ID,
			submissionNumber: 2,
			intents: [{ address: ROW_ADDRESS, presence: 'absent' }],
		});
		const pulled = await context.app.request(documentPath(), {
			headers: { authorization: 'Bearer token' },
		});
		expect(pulled.status).toBe(404);
		expect((await pulled.json()) as unknown).toEqual({ error: 'not-live' });
	} finally {
		context.cleanup();
	}
});
