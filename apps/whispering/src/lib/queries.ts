/**
 * Recordings as TanStack Query observes them: one client, one rule that
 * every query goes stale after every write, the list as a query, and the
 * writes as mutations over the service, as it is.
 *
 * Every write is keyed under `['recordings']` and shares one scope, so
 * writes run one at a time in the order made: a delete never races the
 * save it follows.
 */
import { MutationCache, QueryClient } from '@tanstack/svelte-query';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { recordings } from './app';

export const queryClient = new QueryClient({
	defaultOptions: {
		// The files are on this device: nothing waits for a network.
		queries: {
			networkMode: 'always',
			retry: false,
			staleTime: Number.POSITIVE_INFINITY,
		},
		mutations: { networkMode: 'always' },
	},
	mutationCache: new MutationCache({
		onSettled: (_data, _error, _variables, _rollback, _mutation, { client }) =>
			client.invalidateQueries(),
	}),
});

export const recordingsQueries = resultQueries(['recordings'], {
	list: recordings.list,
});

export const recordingsMutations = resultMutations(['recordings'], {
	addNote: recordings.addNote,
	setTranscript: recordings.setTranscript,
	delete: recordings.delete,
});

queryClient.setMutationDefaults(['recordings'], {
	scope: { id: 'recordings' },
});
