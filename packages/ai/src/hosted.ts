import type { Account } from '@epicenter/account';
import {
	type Endpoint,
	type EndpointModel,
	openAiCompatible,
} from './endpoint.js';
import { AI_MODELS, HOSTED_TRANSCRIPTION_MODEL } from './providers.js';

/** Every model Epicenter's hosted inference serves, from the hosted catalog. */
const HOSTED_MODELS: readonly EndpointModel[] = [
	...AI_MODELS.map((model) => ({
		id: model.id,
		can: ['chat'] as const,
		label: model.label,
	})),
	{ id: HOSTED_TRANSCRIPTION_MODEL, can: ['transcribe'] },
];

/** Why a hosted request was not sent: no one is signed in. Its `name` says so to a caller sorting failures. */
function signedOut(): Promise<never> {
	const error = new Error("Sign in to use Epicenter's models.");
	error.name = 'SignedOut';
	return Promise.reject(error);
}

/**
 * Epicenter's hosted inference at the account's `<origin>/v1`, sent with
 * `account.fetch`, which adds the account's token (on the desktop, the
 * shell's relay does). It lists no models while signed out (`account` is
 * absent) or once the account is retired by sign-out, and its requests are
 * refused then: signed out, with an error named `SignedOut`, before anything
 * is sent.
 *
 * `models` narrows the catalog to the ids an app offers; by default every
 * hosted model is listed.
 */
export function hosted(
	account: Account | null | undefined,
	{ models }: { models?: readonly string[] } = {},
): Endpoint {
	const offered = HOSTED_MODELS.filter(
		(model) => !models || models.includes(model.id),
	);
	if (!account)
		return {
			id: 'hosted',
			name: 'Epicenter',
			source: 'hosted',
			models: () => [],
			fetch: signedOut,
		};
	return {
		...openAiCompatible({
			id: 'hosted',
			name: 'Epicenter',
			source: 'hosted',
			baseUrl: `${account.baseURL.replace(/\/+$/, '')}/v1`,
			fetch: account.fetch,
			models: () => (account.signal.aborted ? [] : offered),
		}),
		subscribe(listener) {
			account.signal.addEventListener('abort', listener, { once: true });
			return () => account.signal.removeEventListener('abort', listener);
		},
	};
}
