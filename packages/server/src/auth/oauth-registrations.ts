/**
 * First-party clients and resources are rows, not admin-session API calls
 * (ADR-0549), and {@link registerFirstPartyClients} is their one writer: the
 * Bun entry calls it at boot, and the Worker once per isolate before its first
 * authorization-server request. Resources are insert-only, matching the
 * provider's `resourceSeedMode`; a first-party client is rewritten to its
 * declaration, because its redirects follow the deployment's origin.
 */
import { and, eq, inArray, notInArray } from 'drizzle-orm';
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

/**
 * Insert missing resources, write every first-party client to its
 * declaration, and make each client's resource links exactly the declared
 * ones. Each statement is idempotent on its own, so writers that run at once
 * (two Worker isolates starting together) converge, and a write cut short is
 * finished by the next one. Inserts name no conflict target: a row has two
 * unique keys (`id` and the client ID or identifier), and Postgres raises on
 * a concurrent duplicate of any key the conflict clause does not name. There
 * is no transaction, so the write can share a connection with other queries,
 * such as the provider seeding its resources as a Better Auth instance
 * initializes.
 */
export async function registerFirstPartyClients(
	db: Db,
	{
		audiences,
		clients,
	}: { audiences: OAuthAudiences; clients: FirstPartyClient[] },
): Promise<void> {
	const now = new Date();
	await db
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
		.onConflictDoNothing();
	for (const client of clients) {
		const { id, ...row } = firstPartyClientRow(client);
		await db
			.insert(oauthClient)
			.values({ ...row, id, createdAt: now, updatedAt: now })
			.onConflictDoNothing();
		await db
			.update(oauthClient)
			.set({ ...row, updatedAt: now })
			.where(eq(oauthClient.clientId, client.clientId));
	}
	const links = clients.flatMap((client) =>
		client.resources.map((resourceId) => ({
			id: `${client.clientId} ${resourceId}`,
			clientId: client.clientId,
			resourceId,
			createdAt: now,
		})),
	);
	await db.delete(oauthClientResource).where(
		and(
			inArray(
				oauthClientResource.clientId,
				clients.map((client) => client.clientId),
			),
			notInArray(
				oauthClientResource.id,
				links.map((link) => link.id),
			),
		),
	);
	if (links.length)
		await db.insert(oauthClientResource).values(links).onConflictDoNothing();
}
