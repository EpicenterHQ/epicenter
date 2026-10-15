/**
 * First-party clients and resources are rows, not admin-session API calls
 * (ADR-0549). The hosted cloud's rows are seeded by a migration in
 * `apps/api/drizzle`; a deployment that serves another origin (the Bun entry:
 * local dev and self-host) writes its own at boot with
 * {@link registerFirstPartyClients}. Resources are insert-only, matching the
 * provider's `resourceSeedMode`; a first-party client is rewritten to its
 * declaration, because its redirects follow the deployment's origin.
 */
import { inArray, sql } from 'drizzle-orm';
import type { Db } from '../db/create-db.js';
import {
	oauthClient,
	oauthClientResource,
	oauthResource,
} from '../db/schema/oauth.js';
import {
	type OAuthAudiences,
	type OAuthScope,
	oauthResourceInputs,
} from './oauth-policy.js';

/** One pre-registered public client. Its registration is its ceiling. */
export type FirstPartyClient = {
	/** The app id, such as `so.epicenter.todos`. */
	clientId: string;
	/** Shown on the device approval page. */
	name: string;
	/** Exact redirects; a loopback redirect matches on any port (RFC 8252). */
	redirectUris: string[];
	grantTypes: (
		| 'authorization_code'
		| 'refresh_token'
		| 'urn:ietf:params:oauth:grant-type:device_code'
	)[];
	scopes: OAuthScope[];
	/** The audiences this client may request. */
	resources: string[];
	/** True for an app that gets target `*` without a prompt. */
	skipConsent: boolean;
	applicationType: 'web' | 'native';
};

/** The `oauth_client` row a first-party client declares. */
export function firstPartyClientRow(client: FirstPartyClient) {
	return {
		id: client.clientId,
		clientId: client.clientId,
		name: client.name,
		redirectUris: client.redirectUris,
		grantTypes: client.grantTypes,
		responseTypes: client.grantTypes.includes('authorization_code')
			? ['code']
			: [],
		scopes: client.scopes,
		skipConsent: client.skipConsent,
		applicationType: client.applicationType,
		tokenEndpointAuthMethod: 'none',
		requirePKCE: true,
		disabled: false,
	};
}

/** Insert missing resources and write every first-party client and its links. */
export async function registerFirstPartyClients(
	db: Db,
	{
		audiences,
		clients,
	}: { audiences: OAuthAudiences; clients: FirstPartyClient[] },
): Promise<void> {
	const now = new Date();
	await db.transaction(async (tx) => {
		await tx
			.insert(oauthResource)
			.values(
				oauthResourceInputs(audiences).map((resource) => ({
					id: resource.identifier,
					identifier: resource.identifier,
					name: resource.identifier,
					accessTokenTtl: resource.accessTokenTtl,
					allowedScopes: resource.allowedScopes,
					createdAt: now,
					updatedAt: now,
				})),
			)
			.onConflictDoNothing({ target: oauthResource.identifier });
		for (const client of clients) {
			const row = firstPartyClientRow(client);
			await tx
				.insert(oauthClient)
				.values({ ...row, createdAt: now, updatedAt: now })
				.onConflictDoUpdate({
					target: oauthClient.clientId,
					set: { ...row, id: sql`${oauthClient.id}`, updatedAt: now },
				});
		}
		const clientIds = clients.map((client) => client.clientId);
		await tx
			.delete(oauthClientResource)
			.where(inArray(oauthClientResource.clientId, clientIds));
		const links = clients.flatMap((client) =>
			client.resources.map((resourceId) => ({
				id: `${client.clientId} ${resourceId}`,
				clientId: client.clientId,
				resourceId,
				createdAt: now,
			})),
		);
		if (links.length) await tx.insert(oauthClientResource).values(links);
	});
}
