/**
 * Data V1 Deployment Authentication Tests
 *
 * Composes each production principal resolver with the scalar and document
 * publication mounts. The authority is a narrow capture fake because these
 * cases prove deployment gates and partition selection, not storage semantics.
 *
 * Key behaviors:
 * - a real hosted OAuth bearer selects its authenticated user partition
 * - the self-host operator bearer always selects the literal instance partition
 * - invalid hosted and self-host bearers cannot reach either authority route
 */

import { expect, test } from 'bun:test';

import { oauthProvider } from '@better-auth/oauth-provider';
import { EPICENTER_OAUTH_SCOPES } from '@epicenter/constants/oauth-clients';
import {
	DOCUMENT_PUBLICATION_VERSION,
	documentPayloadDigest,
} from '@epicenter/data/document-v1';
import { INSTANCE_PRINCIPAL_ID, type PrincipalId } from '@epicenter/identity';
import { betterAuth } from 'better-auth';
import { type MemoryDB, memoryAdapter } from 'better-auth/adapters/memory';
import { jwt } from 'better-auth/plugins';
import { Hono } from 'hono';
import { Ok } from 'wellcrafted/result';

import { JWT_SIGNING_ALG } from '../auth/base-config.js';
import { createEnvTokenResolver } from '../auth/instance-token.js';
import {
	requireBearerPrincipal,
	resolveRequestOAuthPrincipal,
} from '../middleware/require-auth.js';
import { createOAuthTestDb, issueOAuthTokens } from '../test-helpers/oauth.js';
import type { CloudEnv, Env } from '../types.js';
import { authorityV1TestLimits } from './authority-v1-cases.test-support.js';
import {
	DOCUMENT_DIGEST_HEADER,
	DOCUMENT_LIFETIME_HEADER,
	DOCUMENT_PROTOCOL_HEADER,
	type DocumentAuthorityV1Endpoint,
	mountDocumentV1App,
} from './document-v1-route.js';
import {
	mountScalarV1App,
	SCALAR_V1_FACTS_PATH,
	SCALAR_V1_SUBMISSIONS_PATH,
	type ScalarAuthorityV1Endpoint,
} from './scalar-v1-route.js';

const LIFETIME = 'deployment-auth-lifetime';
const INSTANCE_TOKEN = 'instance-token-0123456789abcdef0123456789abcdef';
const ADDRESS = {
	namespace: 'so.epicenter.whispering',
	collection: 'recordings',
	recordKey: 'aaaaaaaaaaaaaaaaaaaaaaaa',
} as const;
const DOCUMENT_PATH = `/api/sync/v1/records/${ADDRESS.namespace}/${ADDRESS.collection}/${ADDRESS.recordKey}/document-publications`;
const DOCUMENT_PAYLOAD = new Uint8Array([1, 2, 3]);

function createCaptureAuthority(principals: PrincipalId[]) {
	const authority: ScalarAuthorityV1Endpoint & DocumentAuthorityV1Endpoint = {
		readFacts: () =>
			Ok({ authorityLifetime: LIFETIME, facts: [], hasMore: false }),
		submit: (request) =>
			Ok({
				authorityLifetime: request.authorityLifetime,
				facts: [],
				parked: [],
			}),
		acceptDocument: (request) => ({
			kind: 'accepted',
			receipt: {
				authorityLifetime: request.authorityLifetime,
				address: request.address,
				protocolVersion: request.protocolVersion,
				digest: request.digest,
			},
		}),
	};
	return {
		locateAuthority(principalId: PrincipalId) {
			principals.push(principalId);
			return authority;
		},
	};
}

function submissionBody() {
	return JSON.stringify({
		authorityLifetime: LIFETIME,
		replicaId: 'rrrrrrrrrrrrrrrrrrrrrrrr',
		submissionNumber: 1,
		intents: [{ address: ADDRESS, op: 'replace', value: 'authenticated' }],
	});
}

async function requestAll<E extends Env>(app: Hono<E>, bearer: string) {
	const headers = { authorization: `Bearer ${bearer}` };
	const facts = await app.request(`${SCALAR_V1_FACTS_PATH}?afterSequence=0`, {
		headers,
	});
	const submission = await app.request(SCALAR_V1_SUBMISSIONS_PATH, {
		method: 'POST',
		headers: { ...headers, 'content-type': 'application/json' },
		body: submissionBody(),
	});
	const document = await app.request(DOCUMENT_PATH, {
		method: 'POST',
		headers: {
			...headers,
			'content-type': 'application/octet-stream',
			[DOCUMENT_LIFETIME_HEADER]: LIFETIME,
			[DOCUMENT_PROTOCOL_HEADER]: DOCUMENT_PUBLICATION_VERSION,
			[DOCUMENT_DIGEST_HEADER]: documentPayloadDigest(DOCUMENT_PAYLOAD),
		},
		body: DOCUMENT_PAYLOAD,
	});
	return { facts, submission, document };
}

function expectInvalidBearer(response: Response): void {
	expect(response.status).toBe(401);
	expect(response.headers.get('WWW-Authenticate')).toBe(
		'Bearer error="invalid_token"',
	);
}

function createHostedSetup() {
	const db = createOAuthTestDb();
	const baseURL = 'http://localhost:18787';
	const auth = betterAuth({
		database: memoryAdapter(db),
		emailAndPassword: { enabled: true },
		basePath: '/auth',
		baseURL,
		secret: 'test-secret-test-secret-test-secret',
		plugins: [
			jwt({ jwks: { keyPairConfig: { alg: JWT_SIGNING_ALG } } }),
			oauthProvider({
				loginPage: '/sign-in',
				consentPage: '/consent',
				requirePKCE: true,
				validAudiences: [baseURL],
				allowDynamicClientRegistration: false,
				scopes: [...EPICENTER_OAUTH_SCOPES],
				silenceWarnings: {
					oauthAuthServerConfig: true,
					openidConfig: true,
				},
			}),
		],
	});
	const principals: PrincipalId[] = [];
	const app = new Hono<CloudEnv>().use('*', async (c, next) => {
		c.set('db', createFakeDb(db));
		c.set('auth', auth as unknown as CloudEnv['Variables']['auth']);
		c.set('authBaseURL', baseURL);
		await next();
	});
	mountScalarV1App(app, {
		auth: requireBearerPrincipal(resolveRequestOAuthPrincipal),
		limits: authorityV1TestLimits(),
		rawSubmissionBytes: 262144,
		...createCaptureAuthority(principals),
	});
	mountDocumentV1App(app, {
		auth: requireBearerPrincipal(resolveRequestOAuthPrincipal),
		limits: authorityV1TestLimits(),
		...createCaptureAuthority(principals),
	});
	return { app, auth, baseURL, db, principals };
}

function createFakeDb(memoryDb: MemoryDB) {
	return {
		query: {
			user: {
				findFirst: async () => memoryDb.user?.[0] ?? null,
			},
		},
	} as unknown as CloudEnv['Variables']['db'];
}

test('hosted OAuth selects one principal for scalar and document publication', async () => {
	const setup = createHostedSetup();
	const { accessToken } = await issueOAuthTokens(setup, {
		clientName: 'Scalar V1 Auth Test',
		email: 'scalar-v1@example.com',
		name: 'Scalar V1',
	});
	const userId = setup.db.user?.[0]?.id;
	expect(userId).toBeString();

	const accepted = await requestAll(setup.app, accessToken);
	expect(accepted.facts.status).toBe(200);
	expect(accepted.submission.status).toBe(200);
	expect(accepted.document.status).toBe(200);
	expect(setup.principals).toEqual([userId, userId, userId]);

	const rejected = await requestAll(setup.app, 'not-a-real-jwt');
	expectInvalidBearer(rejected.facts);
	expectInvalidBearer(rejected.submission);
	expectInvalidBearer(rejected.document);
	expect(setup.principals).toEqual([userId, userId, userId]);
});

test('self-host bearer selects only the instance principal for every data route', async () => {
	const principals: PrincipalId[] = [];
	const app = new Hono<Env>();
	mountScalarV1App(app, {
		auth: requireBearerPrincipal(createEnvTokenResolver(INSTANCE_TOKEN)),
		limits: authorityV1TestLimits(),
		rawSubmissionBytes: 262144,
		...createCaptureAuthority(principals),
	});
	mountDocumentV1App(app, {
		auth: requireBearerPrincipal(createEnvTokenResolver(INSTANCE_TOKEN)),
		limits: authorityV1TestLimits(),
		...createCaptureAuthority(principals),
	});

	const accepted = await requestAll(app, INSTANCE_TOKEN);
	expect(accepted.facts.status).toBe(200);
	expect(accepted.submission.status).toBe(200);
	expect(accepted.document.status).toBe(200);
	expect(principals).toEqual([
		INSTANCE_PRINCIPAL_ID,
		INSTANCE_PRINCIPAL_ID,
		INSTANCE_PRINCIPAL_ID,
	]);

	const rejected = await requestAll(app, `${INSTANCE_TOKEN}-wrong`);
	expectInvalidBearer(rejected.facts);
	expectInvalidBearer(rejected.submission);
	expectInvalidBearer(rejected.document);
	expect(principals).toEqual([
		INSTANCE_PRINCIPAL_ID,
		INSTANCE_PRINCIPAL_ID,
		INSTANCE_PRINCIPAL_ID,
	]);
});
