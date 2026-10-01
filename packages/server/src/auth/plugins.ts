import { passkey } from '@better-auth/passkey';
import type { BetterAuthOptions } from 'better-auth';
import { bearer } from 'better-auth/plugins/bearer';
import { sessionHandoff } from './session-handoff.js';

/** Build the Better Auth plugins used by the hosted session server. */
export function authPlugins(
	apiBaseURL: string,
	callbacks: readonly string[] = [],
) {
	const origin = apiBaseURL.replace(/\/$/, '');
	const rpID = new URL(origin).hostname;
	return [
		// Better Auth signs and resolves these credentials against its session row.
		bearer({ requireSignature: true }),
		sessionHandoff({
			origin,
			callbacks,
		}),
		passkey({ rpID, rpName: 'Epicenter', origin }),
	] satisfies NonNullable<BetterAuthOptions['plugins']>;
}
