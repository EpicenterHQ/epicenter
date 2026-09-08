import { type } from 'arktype';
import {
	type BetterAuthOptions,
	betterAuth,
	type Session,
	type User,
} from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import * as schema from '../db/schema/index.js';
import {
	APPLE_AUDIENCE,
	generateAppleClientSecret,
} from './apple-client-secret.js';
import { BASE_AUTH_CONFIG } from './base-config.js';
import { createCookieAdvancedConfig } from './cookie-config.js';
import { authPlugins } from './plugins.js';
import { requireAccountSession, SESSION_POLICY } from './session-policy.js';

type Db = NodePgDatabase<typeof schema>;

/**
 * The cloud-only auth env, as BOTH an arktype schema and its inferred type, and
 * the single SSOT for the relational-auth layer's secrets. It lives beside its
 * reader (cloud-only, reached only through `mountCloudAuth`), NOT in the portable
 * {@link ServerBindings}: the relational-auth substrate is a Cloud-only layer, so
 * its env contract is too, and the single-partition instance's env never inherits
 * secrets it does not read (ADR-0076). The cloud threads it onto
 * `createAuth` through `mountCloudAuth` from its own deploy-gated env, the
 * same honest-edge move every Cloudflare-only binding already makes (ADR-0066),
 * so this builder can resolve provider credentials once rather than scattering
 * raw `c.env` checks through auth setup.
 *
 * `BETTER_AUTH_SECRET` is required: every deployment that reaches this composes
 * Better Auth and must sign sessions with a real secret (the runtime gate below
 * is defense-in-depth against an empty value). At the shared library boundary,
 * each OAuth provider stays optional and register-when-present (ADR-0071). The
 * hosted `apps/api` deployable may impose a stricter product promise, such as
 * requiring every provider its static sign-in UI shows.
 */
export const CloudAuthBindings = type({
	BETTER_AUTH_SECRET: 'string',
	'GOOGLE_CLIENT_ID?': 'string',
	'GOOGLE_CLIENT_SECRET?': 'string',
	'GITHUB_CLIENT_ID?': 'string',
	'GITHUB_CLIENT_SECRET?': 'string',
	'MICROSOFT_CLIENT_ID?': 'string',
	'MICROSOFT_CLIENT_SECRET?': 'string',
	// Apple is register-when-present like the others, but "present" means all
	// four parts of the signing material: the Services ID plus the Team ID, Key
	// ID, and .p8 private key the client-secret JWT is minted from (there is no
	// static APPLE_CLIENT_SECRET). See {@link generateAppleClientSecret}.
	'APPLE_CLIENT_ID?': 'string',
	'APPLE_TEAM_ID?': 'string',
	'APPLE_KEY_ID?': 'string',
	'APPLE_PRIVATE_KEY?': 'string',
});
export type CloudAuthBindings = typeof CloudAuthBindings.infer;

/**
 * The single owner of "which OAuth providers can Better Auth register": each
 * provider resolves to its credentials when fully configured and `null`
 * otherwise. Apple is present only when all four parts of its signing material
 * are (the client-secret JWT is minted per request from them; see
 * {@link generateAppleClientSecret}).
 */
export function configuredProviders(env: CloudAuthBindings) {
	return {
		google:
			env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET
				? {
						clientId: env.GOOGLE_CLIENT_ID,
						clientSecret: env.GOOGLE_CLIENT_SECRET,
					}
				: null,
		github:
			env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET
				? {
						clientId: env.GITHUB_CLIENT_ID,
						clientSecret: env.GITHUB_CLIENT_SECRET,
					}
				: null,
		microsoft:
			env.MICROSOFT_CLIENT_ID && env.MICROSOFT_CLIENT_SECRET
				? {
						clientId: env.MICROSOFT_CLIENT_ID,
						clientSecret: env.MICROSOFT_CLIENT_SECRET,
					}
				: null,
		apple:
			env.APPLE_CLIENT_ID &&
			env.APPLE_TEAM_ID &&
			env.APPLE_KEY_ID &&
			env.APPLE_PRIVATE_KEY
				? {
						clientId: env.APPLE_CLIENT_ID,
						teamId: env.APPLE_TEAM_ID,
						keyId: env.APPLE_KEY_ID,
						privateKey: env.APPLE_PRIVATE_KEY,
					}
				: null,
	};
}

/**
 * Assemble and return a configured `betterAuth()` instance from runtime deps.
 *
 * Cloudflare Workers doesn't expose `env` or database connections at module scope,
 * so this defers Better Auth initialization to request time. The returned object is
 * the raw Better Auth instance, with no wrapper or additional abstraction.
 *
 * Wires up:
 * - Drizzle adapter (portable Postgres wire; Hyperdrive on Workers, a pool on Node)
 * - Google OAuth, plus GitHub, Microsoft, and Apple when their credentials are
 *   configured (email/password is disabled; see {@link BASE_AUTH_CONFIG})
 * - Plugins: signed session bearer, PKCE session handoff, passkey (WebAuthn)
 *
 * `/api/session` is the single Epicenter session surface; this builder no longer
 * enriches `/auth/get-session` with encryption keys.
 */
export function createAuth({
	db,
	env,
	baseURL,
	trustedOrigins,
	sessionCallbacks = [],
}: {
	db: Db;
	env: CloudAuthBindings;
	baseURL: string;
	/** Deployment-supplied trusted origins (CORS, CSRF, redirect allow-list). */
	trustedOrigins: string[];
	/** Exact callbacks approved by this deployment, independent of CORS trust. */
	sessionCallbacks?: readonly string[];
}) {
	// Better Auth signs session credentials and OAuth state with this secret. Handed
	// an empty or missing one, the library silently falls back to its PUBLIC default
	// (`better-auth-secret-...`) and only throws when `NODE_ENV === 'production'`,
	// which is never set on a Worker. That is forgeable session signing, so fail
	// closed at the one place the secret reaches Better Auth. This makes the
	// guarantee runtime, not deploy-time only (the wrangler `secrets.required` gate
	// blocks a missing secret at deploy, but not a later dashboard deletion or a
	// preview path), and it covers both cloud entries since both reach `betterAuth`
	// only through here (ADR-0076).
	const secret = env.BETTER_AUTH_SECRET?.trim();
	if (!secret) {
		throw new Error(
			'BETTER_AUTH_SECRET is not set: refusing to construct Better Auth with an empty signing secret, which would fall back to a public default and sign forgeable sessions.',
		);
	}
	// One presence predicate for all four providers (see configuredProviders).
	// `apple` is bound to a local so its narrowing survives into the async
	// client-secret factory below; the same value gates the trusted-origin
	// addition (Apple posts its callback from appleid.apple.com).
	const providers = configuredProviders(env);
	const apple = providers.apple;
	const auth = betterAuth({
		...BASE_AUTH_CONFIG,
		database: drizzleAdapter(db, { provider: 'pg', schema }),
		baseURL,
		secret,
		// `account` (accountLinking) comes from BASE_AUTH_CONFIG via the spread.
		//
		// The Better Auth state-cookie check stays ENABLED (its default). The
		// Google sign-in leg validates the callback two ways: a single-use
		// Postgres verification record AND a signed state cookie set during the
		// sign-in POST. An earlier note disabled the cookie check on the theory
		// that the sign-in POST was a cross-origin fetch whose third-party
		// Set-Cookie browsers would drop. That is not how this deploys: the only
		// caller of `/auth/sign-in/social` is the API-hosted Svelte sign-in page,
		// which fetches a same-origin relative URL, so the state cookie is
		// first-party, stored, and sent on the
		// Google callback navigation. The cookie binds the callback to the
		// initiating browser (the DB record alone does not), so keeping the check
		// on restores that login-CSRF / session-fixation defense.
		//
		// Each provider is registered only when its credentials are configured.
		// The hosted apps/api deployable requires the four providers its static UI
		// shows, while this shared builder keeps the lower-level register-when-present
		// behavior. The single-partition instance offers none: it composes no Better
		// Auth at all (this builder is cloud-only, reached only through
		// `mountCloudAuth`), and the operator bearer is its only gate (ADR-0075).
		// better-auth requests `read:user` +
		// `user:email` for GitHub by default, so it reads the primary email and
		// GitHub's verification flag. GitHub is deliberately NOT a trusted linking
		// provider (see BASE_AUTH_CONFIG): an unverified GitHub email must not link
		// into an existing account.
		socialProviders: {
			...(providers.google ? { google: providers.google } : {}),
			...(providers.github ? { github: providers.github } : {}),
			// Microsoft (Entra / personal MSA), register-when-present like GitHub.
			// tenantId defaults to 'common' so both work/school and personal
			// accounts can sign in. Like GitHub, Microsoft is deliberately NOT a
			// trusted linking provider (see BASE_AUTH_CONFIG): a personal MSA email
			// is not a guaranteed-verified assertion, so an untrusted Microsoft
			// identity only links to an existing same-email account when Microsoft
			// itself reports the email verified.
			...(providers.microsoft ? { microsoft: providers.microsoft } : {}),
			// Apple's clientSecret is a per-request-minted ES256 JWT, so this is
			// an async factory rather than a static pair over the configured
			// signing material. Like GitHub and Microsoft, Apple is NOT a trusted
			// linking provider: it can issue a private-relay email, so an
			// untrusted Apple identity only links to an existing same-email
			// account when Apple reports the email verified.
			...(apple
				? {
						apple: async () => ({
							clientId: apple.clientId,
							clientSecret: await generateAppleClientSecret(apple),
						}),
					}
				: {}),
		},
		session: SESSION_POLICY,
		// Cookie transport for browser clients: host-only, SameSite=Lax
		// everywhere (non-secure on localhost so the Vite `/auth` proxy works).
		// Hosted sign-in uses cookies; dashboard management and application data
		// use captured session bearers. No cross-subdomain cookie is needed.
		//
		// NOTE: We intentionally omit `partitioned: true` (CHIPS).
		// Partitioned cookies are keyed by the top-level site at creation
		// time. During OAuth the top-level site changes mid-flow (client to
		// Google to API callback), so the cookie becomes invisible at the
		// callback step. Partitioned is for iframes, not redirect OAuth.
		advanced: createCookieAdvancedConfig(baseURL),
		// Apple posts its OAuth callback from appleid.apple.com (response_mode=
		// form_post), so that origin must be trusted for the flow to complete.
		// Only added when Apple is configured, to avoid widening the allow-list.
		trustedOrigins: apple
			? [...trustedOrigins, APPLE_AUDIENCE]
			: trustedOrigins,
		// Postgres is the only auth store: sessions and OAuth verification
		// records persist to the DB adapter. Cookie caching is disabled so
		// session revocation takes effect on the next authenticated request.
		//
		// Rate limiting consequently runs in-process, not in a shared store:
		// dropping KV flips Better Auth's default from "secondary-storage" to
		// "memory", so on the Worker each isolate keeps its own counters.
		// Acceptable here because email/password is disabled and social OAuth is
		// the only sign-in path (see BASE_AUTH_CONFIG), so there is no password
		// brute-force surface a shared counter would protect; a single self-host
		// process gets exact in-memory limiting for free. Upgrade trigger: add a
		// `rateLimit` table to the schema and set `storage: 'database'` if
		// durable, shared limiting is ever needed.
		rateLimit: { storage: 'memory' },
		plugins: authPlugins(baseURL, sessionCallbacks),
		hooks: {
			before: requireAccountSession(
				(headers): Promise<{ session: Session; user: User } | null> =>
					auth.api.getSession({
						headers,
						query: { disableCookieCache: true, disableRefresh: true },
					}),
			),
		},
	} satisfies BetterAuthOptions);
	return auth;
}
