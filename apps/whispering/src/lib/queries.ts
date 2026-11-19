/**
 * The data modules as TanStack Query sees them: one client, one rule that
 * every query goes stale after every write, each read as a query, and each
 * write as a mutation over the module as it is.
 *
 * Writes to one entity share one scope, so they run one at a time in the
 * order made: a delete never races the save it follows, and two settings
 * changes never write over each other.
 */
import { MutationCache, QueryClient } from '@tanstack/svelte-query';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { recordings, settings } from './app';

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
	add: recordings.add,
	setTranscript: recordings.setTranscript,
	delete: recordings.delete,
});

export const settingsQueries = resultQueries(['settings'], {
	read: settings.read,
});

export const settingsMutations = resultMutations(['settings'], {
	update: settings.update,
});

queryClient.setMutationDefaults(['recordings'], {
	scope: { id: 'recordings' },
});
queryClient.setMutationDefaults(['settings'], { scope: { id: 'settings' } });
