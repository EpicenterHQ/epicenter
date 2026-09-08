/**
 * Vocab's device-local inference connection registry (ADR-0059).
 *
 * One shared registry (built once here) that the header picker, the engine, and
 * the cross-device banner all read. Hosted is Vocab's one curated model
 * (`VOCAB_MODEL`); custom connections and their discovered models live in
 * localStorage, never synced (a key is a secret and a `localhost` URL is
 * meaningless elsewhere, ADR-0004).
 */

import { createInferenceConnections } from '@epicenter/app-shell/inference-picker';
import type { Account } from '@epicenter/auth';
import { toHostedCatalog } from '@epicenter/constants/ai-providers';
import { API_ROUTES } from '@epicenter/constants/api-routes';
import { createPersistedState } from '@epicenter/svelte';
import { VOCAB_MODEL } from '$lib/data';

export const createVocabConnections = (account: Account) =>
	createInferenceConnections({
		storageKey: 'vocab',
		hostedModels: toHostedCatalog([VOCAB_MODEL]),
		hosted: {
			fetch: account.fetch,
			baseURL: API_ROUTES.ai.baseUrl(account.baseURL),
		},
		persist: (key, schema, defaultValue) =>
			createPersistedState({ key, schema, defaultValue }),
	});
