/**
 * The social providers the hosted sign-in and account pages offer.
 *
 * One authoritative record, provider id to display label; the id union and the
 * ordered list derive from it, so adding a provider is a single line here.
 *
 * This is a static list, not a server-driven one: Epicenter's hosted cloud
 * requires the credentials for every provider shown here, and this UI only ever
 * runs in that hosted cloud. The server is still the real guard,
 * `createAuth` registers only the providers it has secrets for, so Better Auth
 * rejects a sign-in for an unconfigured provider at the call.
 */
export const PROVIDER_LABELS = {
	google: 'Google',
	github: 'GitHub',
	microsoft: 'Microsoft',
} as const;

export type SocialProvider = keyof typeof PROVIDER_LABELS;

/** Insertion order is the display order. */
export const SOCIAL_PROVIDERS = Object.keys(
	PROVIDER_LABELS,
) as SocialProvider[];
