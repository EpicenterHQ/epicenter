/**
 * A grant targets `*` (every namespace the person is a member of, now and
 * later) or one namespace, `ns:<id>` (ADR-0549). The person picks it on the
 * consent page or the device approval page; the provider stores it as the
 * consent's `referenceId` and copies it onto every token.
 *
 * The page stages its choice through `POST /grant-target/select` before it
 * posts the consent or the device approval. A staged choice lives in
 * Better Auth's `verification` table for ten minutes and is consumed by the
 * decision it was made for, so it cannot leak into a later grant.
 */
import { tryGetCurrentAuthEndpointContext } from '@better-auth/core/context';
import {
	DEVICE_CODE_GRANT_TYPE,
	getOAuthProviderState,
} from '@better-auth/oauth-provider';
import { type } from 'arktype';
import type { BetterAuthPlugin, Session, User } from 'better-auth';
import {
	APIError,
	createAuthEndpoint,
	createAuthMiddleware,
	sessionMiddleware,
} from 'better-auth/api';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';
import { namespace, namespaceMember } from '../db/schema/namespace.js';
import { hashPrefixedToken, TOKEN_PREFIX } from './oauth-policy.js';

/** Every namespace the person is a member of, now and later. */
export const ALL_NAMESPACES_TARGET = '*';
const SELECTION_TTL_MS = 10 * 60 * 1000;

/** Matches no stored consent, so the provider shows the consent page. */
const UNSELECTED = 'unselected';

export type GrantTarget = typeof ALL_NAMESPACES_TARGET | `ns:${string}`;

/** One choice on the consent or device approval page. */
export type GrantTargetOption = {
	target: GrantTarget;
	/** "All folders", "Personal", or the group's title. */
	label: string;
};

const consentKey = (sessionId: string, clientId: string) =>
	`grant-target:consent:${sessionId}:${clientId}`;
const deviceKey = (deviceCodeId: string) =>
	`grant-target:device:${deviceCodeId}`;

type VerificationAdapter = {
	internalAdapter: {
		findVerificationValue(
			identifier: string,
		): Promise<{ value: string; expiresAt: Date } | null>;
		deleteVerificationByIdentifier(identifier: string): Promise<void>;
		createVerificationValue(data: {
			identifier: string;
			value: string;
			expiresAt: Date;
		}): Promise<unknown>;
	};
};

async function readSelection(
	context: VerificationAdapter,
	key: string,
): Promise<GrantTarget | undefined> {
	const row = await context.internalAdapter.findVerificationValue(key);
	if (!row || row.expiresAt.getTime() <= Date.now()) return undefined;
	return row.value as GrantTarget;
}

/** The targets one account may choose, personal namespace first. */
export async function listGrantTargets(
	db: Db,
	accountId: string,
): Promise<GrantTargetOption[]> {
	const rows = await db
		.select({
			id: namespace.id,
			title: namespace.title,
			personal: sql<boolean>`${namespace.personalAccountId} = ${accountId}`,
		})
		.from(namespaceMember)
		.innerJoin(namespace, eq(namespace.id, namespaceMember.namespaceId))
		.where(eq(namespaceMember.accountId, accountId))
		.orderBy(sql`${namespace.personalAccountId} is null`, asc(namespace.title));
	return [
		{ target: ALL_NAMESPACES_TARGET, label: 'All folders' },
		...rows.map((row) => ({
			target: `ns:${row.id}` as const,
			label: row.personal ? 'Personal' : row.title,
		})),
	];
}

async function isMember(db: Db, namespaceId: string, accountId: string) {
	const [row] = await db
		.select({ role: namespaceMember.role })
		.from(namespaceMember)
		.where(
			and(
				eq(namespaceMember.namespaceId, namespaceId),
				eq(namespaceMember.accountId, accountId),
			),
		)
		.limit(1);
	return row !== undefined;
}

type DeviceCodeRow = { id: string; userCode: string; userId?: string | null };

async function findDeviceCode(
	adapter: {
		findOne<T>(query: {
			model: string;
			where: { field: string; value: string }[];
		}): Promise<T | null>;
	},
	userCode: string,
): Promise<DeviceCodeRow | null> {
	// The device plugin also accepts the code without separators.
	for (const value of new Set([
		userCode,
		userCode.replace(/[^a-zA-Z0-9]/g, '').toUpperCase(),
	])) {
		const row = await adapter.findOne<DeviceCodeRow>({
			model: 'deviceCode',
			where: [{ field: 'userCode', value }],
		});
		if (row?.userCode === value) return row;
	}
	return null;
}

/**
 * The provider's `postLogin.consentReferenceId`. It runs when `/oauth2/authorize`
 * looks for an existing consent and when `/oauth2/consent` records one.
 *
 * - A first-party client that skips consent gets `*` without a prompt.
 * - Otherwise a choice this browser session staged for this client wins.
 * - At authorize, an untrusted client reuses the target of the person's latest
 *   consent for it (silent re-authorization); without one, a sentinel that
 *   matches no consent sends the person to the consent page.
 * - At consent, no staged choice is a refusal: the page must ask.
 */
export async function resolveConsentReferenceId({
	user,
	session,
}: {
	user: User;
	session: Session;
}): Promise<string> {
	const endpoint = await tryGetCurrentAuthEndpointContext();
	if (!endpoint) throw new Error('consentReferenceId ran outside an endpoint');
	const { context } = endpoint;
	const state = await getOAuthProviderState();
	const clientId = state?.query
		? new URLSearchParams(state.query).get('client_id')
		: null;
	if (!clientId) throw new Error('consentReferenceId ran without a client');
	const client = await context.adapter.findOne<{
		skipConsent?: boolean | null;
	}>({
		model: 'oauthClient',
		where: [{ field: 'clientId', value: clientId }],
	});
	if (client?.skipConsent) return ALL_NAMESPACES_TARGET;
	const staged = await readSelection(context, consentKey(session.id, clientId));
	if (staged) return staged;
	if (endpoint.path === '/oauth2/consent')
		throw new APIError('BAD_REQUEST', {
			error: 'invalid_request',
			error_description: 'Choose which folders this app can reach.',
		});
	const [prior] = await context.adapter.findMany<{
		referenceId?: string | null;
	}>({
		model: 'oauthConsent',
		where: [
			{ field: 'clientId', value: clientId },
			{ field: 'userId', value: user.id },
		],
		sortBy: { field: 'updatedAt', direction: 'desc' },
		limit: 1,
	});
	return prior?.referenceId ?? UNSELECTED;
}

/** A choice for one app's consent (`client_id`) or one device code (`user_code`). */
const SelectBody = type({
	target: 'string',
	'client_id?': 'string',
	'user_code?': 'string',
});

/**
 * The grant-target plugin: the staging and listing endpoints for the consent
 * and device approval pages, the consumption of a staged choice, and the
 * device grant's target, which the provider's device exchange does not carry.
 */
export function grantTarget({ db }: { db: Db }) {
	return {
		id: 'grant-target',
		endpoints: {
			/** The choices the consent and device approval pages offer. */
			listGrantTargets: createAuthEndpoint(
				'/grant-target/options',
				{ method: 'GET', use: [sessionMiddleware] },
				async (ctx) =>
					ctx.json(await listGrantTargets(db, ctx.context.session.user.id)),
			),
			/** Stage the person's choice for the consent or approval it precedes. */
			selectGrantTarget: createAuthEndpoint(
				'/grant-target/select',
				{ method: 'POST', body: SelectBody, use: [sessionMiddleware] },
				async (ctx) => {
					const { session, user } = ctx.context.session;
					const { target, client_id, user_code } = ctx.body;
					if ((client_id === undefined) === (user_code === undefined))
						throw new APIError('BAD_REQUEST', {
							message:
								'Name the app (client_id) or the device code (user_code).',
						});
					if (target !== ALL_NAMESPACES_TARGET) {
						const id = /^ns:([a-z0-9]{12})$/.exec(target)?.[1];
						if (!id)
							throw new APIError('BAD_REQUEST', {
								message: 'A target is "*" or "ns:<namespace id>".',
							});
						if (!(await isMember(db, id, user.id)))
							throw new APIError('FORBIDDEN', {
								message: 'You are not a member of that namespace.',
							});
					}
					let key = client_id ? consentKey(session.id, client_id) : '';
					if (user_code !== undefined) {
						const deviceCode = await findDeviceCode(
							ctx.context.adapter,
							user_code,
						);
						if (!deviceCode || deviceCode.userId !== user.id)
							throw new APIError('BAD_REQUEST', {
								message: 'Open the code on this page before choosing folders.',
							});
						key = deviceKey(deviceCode.id);
					}
					await ctx.context.internalAdapter.deleteVerificationByIdentifier(key);
					await ctx.context.internalAdapter.createVerificationValue({
						identifier: key,
						value: target,
						expiresAt: new Date(Date.now() + SELECTION_TTL_MS),
					});
					return ctx.json({ target });
				},
			),
		},
		hooks: {
			before: [
				{
					// A device approval without a staged target would mint tokens
					// that reach nothing. Refuse it before the code is approved.
					matcher: (ctx) => ctx.path === '/device/approve',
					handler: createAuthMiddleware(async (ctx) => {
						const userCode = (ctx.body as { userCode?: unknown } | undefined)
							?.userCode;
						if (typeof userCode !== 'string') return;
						const deviceCode = await findDeviceCode(
							ctx.context.adapter,
							userCode,
						);
						if (!deviceCode) return;
						if (!(await readSelection(ctx.context, deviceKey(deviceCode.id))))
							throw new APIError('BAD_REQUEST', {
								error: 'invalid_request',
								error_description:
									'Choose which folders this device can reach.',
							});
					}),
				},
			],
			after: [
				{
					// The consent decision has produced its code, which carries the
					// referenceId. Consume the choice so a later grant asks again.
					matcher: (ctx) => ctx.path === '/oauth2/consent',
					handler: createAuthMiddleware(async (ctx) => {
						const sessionId = ctx.context.session?.session.id;
						const oauthQuery = (
							ctx.body as { oauth_query?: unknown } | undefined
						)?.oauth_query;
						const clientId =
							typeof oauthQuery === 'string'
								? new URLSearchParams(oauthQuery).get('client_id')
								: null;
						if (sessionId && clientId)
							await ctx.context.internalAdapter.deleteVerificationByIdentifier(
								consentKey(sessionId, clientId),
							);
					}),
				},
				{
					// The device exchange issues tokens without a referenceId. The
					// lineage patch stamps them `device:<device code id>`, which names
					// the approval's staged choice; copy it onto both rows.
					matcher: (ctx) =>
						ctx.path === '/oauth2/token' &&
						(ctx.body as { grant_type?: unknown } | undefined)?.grant_type ===
							DEVICE_CODE_GRANT_TYPE,
					handler: createAuthMiddleware(async (ctx) => {
						const issued = ctx.context.returned as
							| { access_token?: unknown; refresh_token?: unknown }
							| undefined;
						if (!issued || typeof issued.access_token !== 'string') return;
						const accessHash = await hashPrefixedToken(
							issued.access_token,
							TOKEN_PREFIX.access,
						);
						if (!accessHash) return;
						const access = await ctx.context.adapter.findOne<{
							authorizationCodeId?: string | null;
						}>({
							model: 'oauthAccessToken',
							where: [{ field: 'token', value: accessHash }],
						});
						const lineage = access?.authorizationCodeId;
						if (!lineage?.startsWith('device:')) return;
						const key = deviceKey(lineage.slice('device:'.length));
						const target = await readSelection(ctx.context, key);
						await ctx.context.internalAdapter.deleteVerificationByIdentifier(
							key,
						);
						// No staged choice leaves referenceId null, which reaches nothing.
						if (!target) return;
						await ctx.context.adapter.updateMany({
							model: 'oauthAccessToken',
							where: [{ field: 'authorizationCodeId', value: lineage }],
							update: { referenceId: target },
						});
						await ctx.context.adapter.updateMany({
							model: 'oauthRefreshToken',
							where: [{ field: 'authorizationCodeId', value: lineage }],
							update: { referenceId: target },
						});
					}),
				},
			],
		},
	} satisfies BetterAuthPlugin;
}
