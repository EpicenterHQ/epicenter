import { DurableObject } from 'cloudflare:workers';

import {
	type AuthorityError,
	type FactsResponse,
	parseFactsRequest,
	parseSubmissionRequest,
	SCALAR_SYNC_V1_LIMITS,
	SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
	type SubmissionResponse,
} from '@epicenter/data/protocol/v1';
import type { PrincipalId } from '@epicenter/identity';
import {
	createDurableObjectSqliteAdapter,
	type DurableObjectSqliteStorage,
} from '@epicenter/sqlite/durable-object';
import type { Hono, MiddlewareHandler } from 'hono';
import type { Result } from 'wellcrafted/result';

import type { Env } from '../types.js';
import {
	openScalarAuthorityV1,
	type ScalarAuthorityV1,
} from './authority-v1.js';
import {
	mountScalarV1App,
	type ScalarAuthorityV1Endpoint,
} from './scalar-v1-route.js';

function principalName(principalId: PrincipalId): string {
	return encodeURIComponent(principalId).replaceAll('.', '%2E');
}

/** One principal-owned scalar V1 authority on Durable Object SQLite. */
export class DataAuthority extends DurableObject<Cloudflare.Env> {
	private authority: ScalarAuthorityV1 | undefined;
	private readonly ready: Promise<void>;

	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		this.ready = ctx.blockConcurrencyWhile(async () => {
			this.authority = this.openFreshOwner();
		});
	}

	async readFacts(
		rawRequest: unknown,
	): Promise<Result<FactsResponse, AuthorityError>> {
		const parsed = parseFactsRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 facts RPC request');
		}
		return (await this.owner()).readFacts(parsed.data);
	}

	async submit(
		rawRequest: unknown,
	): Promise<Result<SubmissionResponse, AuthorityError>> {
		const parsed = parseSubmissionRequest(rawRequest, SCALAR_SYNC_V1_LIMITS);
		if (parsed.error !== null) {
			throw new TypeError('invalid scalar V1 submission RPC request');
		}
		return (await this.owner()).submit(parsed.data);
	}

	/** Delete every scalar V1 byte owned by this principal. */
	async deleteAccount(): Promise<void> {
		await this.ready;
		await this.ctx.blockConcurrencyWhile(async () => {
			await this.ctx.storage.deleteAll();
			// Authentication survives until the hosted deletion coordinator's last
			// step. Reopen an empty successor lifetime so a partial downstream
			// failure does not strand this actor in an unusable in-memory state.
			this.authority = this.openFreshOwner();
		});
	}

	private async owner(): Promise<ScalarAuthorityV1> {
		await this.ready;
		if (this.authority === undefined) {
			throw new Error('scalar V1 authority is unavailable');
		}
		return this.authority;
	}

	private openFreshOwner(): ScalarAuthorityV1 {
		return openScalarAuthorityV1({
			database: createDurableObjectSqliteAdapter(
				this.ctx.storage as unknown as DurableObjectSqliteStorage,
			),
			limits: SCALAR_SYNC_V1_LIMITS,
			initialize: { authorityLifetime: crypto.randomUUID() },
		});
	}
}

/** Narrow RPC namespace shape consumed by the shared mount. */
export type DataAuthorityNamespace = {
	getByName(name: string): ScalarAuthorityV1Endpoint;
};

export type DeletableDataAuthorityNamespace = {
	getByName(name: string): { deleteAccount(): Promise<void> };
};

function stubFor(
	namespace: DataAuthorityNamespace,
	principalId: PrincipalId,
): ScalarAuthorityV1Endpoint {
	const stub = namespace.getByName(principalName(principalId));
	return {
		readFacts: (request) => stub.readFacts(request),
		submit: (request) => stub.submit(request),
	};
}

/** Mount the two authenticated scalar V1 routes on a Cloudflare deployment. */
export function mountCloudflareScalarV1App<E extends Env = Env>(
	app: Hono<E>,
	{
		auth,
		resolveNamespace,
	}: {
		auth: MiddlewareHandler<E>;
		resolveNamespace(env: E['Bindings']): DataAuthorityNamespace;
	},
): void {
	mountScalarV1App(app, {
		auth,
		limits: SCALAR_SYNC_V1_LIMITS,
		rawSubmissionBytes: SCALAR_SYNC_V1_RAW_SUBMISSION_BYTES,
		locateAuthority: (principalId, env) =>
			stubFor(resolveNamespace(env), principalId),
	});
}

/** Bind hosted account deletion to the new principal-owned authority. */
export function createDataAuthorityAccountAuthorities(
	namespace: DeletableDataAuthorityNamespace,
) {
	return {
		authority(principalId: PrincipalId) {
			return {
				deleteAccount: () =>
					namespace.getByName(principalName(principalId)).deleteAccount(),
			};
		},
	};
}
