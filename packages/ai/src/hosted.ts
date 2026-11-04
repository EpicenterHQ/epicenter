import type { Account, AuthClient } from '@epicenter/account';
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

/** What `hosted` reads of the account: who is signed in now, and when that changes. */
export type LiveAccount = Pick<
	AuthClient,
	'getState' | 'subscribe' | 'baseURL'
>;

/** Why a hosted request was not sent: no one is signed in. Its `name` says so to a caller sorting failures. */
function signedOut(): Promise<never> {
	const error = new Error("Sign in to use Epicenter's models.");
	error.name = 'SignedOut';
	return Promise.reject(error);
}

/** `<origin>/v1`, where hosted inference answers. */
const v1 = (origin: string) => `${origin.replace(/\/+$/, '')}/v1`;

/**
 * Epicenter's hosted inference at the account's `<origin>/v1`, sent with
 * the signed-in account's `fetch`, which adds its token (on the desktop, the
 * shell's relay does). It reads the account at every use, so sign-in and
 * sign-out reach it without a new `openAi`: it lists no models while no one
 * is signed in or once the account is retired, and refuses requests then,
 * with an error named `SignedOut`, before anything is sent.
 *
 * Its id and base URL do not change with sign-in, so a request prepared
 * while signed out and sent once signed in still goes where it was
 * prepared for.
 *
 * `models` narrows the catalog to the ids an app offers; by default every
 * hosted model is listed.
 */
export function hosted(
	account: LiveAccount,
	{ models }: { models?: readonly string[] } = {},
): Endpoint {
	const offered = HOSTED_MODELS.filter(
		(model) => !models || models.includes(model.id),
	);
	/** The account signed in now, while it is not retired. */
	function current(): Account | null {
		const state = account.getState();
		if (state.status === 'signed-out' || state.account.signal.aborted)
			return null;
		return state.account;
	}
	return {
		id: 'hosted',
		name: 'Epicenter',
		source: 'hosted',
		get baseUrl() {
			return account.baseURL ? v1(account.baseURL) : undefined;
		},
		models: () => (current() ? offered : []),
		subscribe: (listener) => account.subscribe(listener),
		fetch(path, init) {
			const signedIn = current();
			if (!signedIn) return signedOut();
			return openAiCompatible({
				id: 'hosted',
				name: 'Epicenter',
				source: 'hosted',
				baseUrl: v1(signedIn.baseURL),
				fetch: signedIn.fetch,
				models: () => offered,
			}).fetch(path, init);
		},
	};
}
