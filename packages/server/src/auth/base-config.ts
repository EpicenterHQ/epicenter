import type { BetterAuthOptions } from 'better-auth';
import { SESSION_POLICY } from './session-policy.js';

export const AUTH_BASE_PATH = '/auth';

/** Shared Better Auth config used by both the runtime and the CLI schema tool. */
export const BASE_AUTH_CONFIG = {
	basePath: AUTH_BASE_PATH,
	session: SESSION_POLICY,
	// Email/password is intentionally disabled. No mail sender is wired up,
	// so a local account could never verify. better-auth 1.6.23's
	// `requireLocalEmailVerified` linking gate (default true) closes the old
	// pre-registered-unverified-account takeover path, but an unverifiable
	// credential flow is still not one we serve. Do not re-enable without first
	// wiring email verification (sendVerificationEmail) and
	// requireEmailVerification.
	emailAndPassword: { enabled: false },
	account: {
		// Only Google is a trusted linking provider. A trusted provider bypasses
		// the incoming `emailVerified` check (better-auth 1.6.23 `link-account`
		// gate: `!isTrustedProvider && !userInfo.emailVerified`, plus a
		// `requireLocalEmailVerified` check on the existing user), so the set must
		// contain only IdPs that always assert a verified email. Google does;
		// GitHub does NOT (it can return an unverified primary email), so GitHub
		// is intentionally excluded even when enabled in create-auth.ts: an
		// untrusted GitHub identity only links to an existing same-email account
		// when GitHub itself reports the email verified. `email-password` is
		// absent because local credentials are disabled above.
		accountLinking: {
			enabled: true,
			trustedProviders: ['google'],
			// Let a signed-in user link a provider whose email differs from their
			// account email (a work Google, a work Microsoft, an Apple private
			// relay), so one human keeps one Epicenter identity and one
			// partition instead of fragmenting into separate, unmergeable users.
			// This ONLY relaxes the explicit `/link-social` flow, which runs a full
			// OAuth ceremony proving the user controls the provider; it does NOT
			// enable different-email IMPLICIT linking during sign-in, which is
			// structurally impossible (implicit linking keys on the email match).
			// createAuth's requireAccountSession hook binds linking to the expected
			// principal and requires a session younger than ten minutes.
			allowDifferentEmails: true,
		},
	},
} satisfies BetterAuthOptions;
