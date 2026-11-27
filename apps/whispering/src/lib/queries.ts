/**
 * The data modules, and the platform reads a screen watches (whether a key
 * is kept, which microphones are connected), as TanStack Query sees them:
 * one client, one rule that every query goes stale after every write, each
 * read as a query, and each write as a mutation over the module as it is.
 *
 * Writes to one entity share one scope, so they run one at a time in the
 * order made: a delete never races the save it follows, and two settings
 * changes never write over each other.
 */
import { MutationCache, QueryClient } from '@tanstack/svelte-query';
import { resultMutations, resultQueries } from 'wellcrafted/query';
import { recordings } from './data/recordings';
import { settings } from './data/settings';
import { textFiles } from './data/text-files';
import { recorder, servers } from './platform/index';

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

export const textFilesQueries = resultQueries(['textFiles'], {
	read: textFiles.read,
});

export const textFilesMutations = resultMutations(['textFiles'], {
	write: textFiles.write,
	remove: textFiles.remove,
});

/** Whether a server's API key is kept, by the server's origin. The key itself is never read back. */
export const keysQueries = resultQueries(['keys'], {
	has: servers.hasKey,
});

export const keysMutations = resultMutations(['keys'], {
	/** Keep `key` for the server at `baseUrl`; an empty key forgets the one kept. */
	set: ({ baseUrl, key }: { baseUrl: string; key: string }) =>
		servers.setKey(baseUrl, key),
});

/** The microphones connected now. Asked again each time a screen opens it. */
export const microphonesQueries = resultQueries(['microphones'], {
	list: recorder.inputs,
});

queryClient.setQueryDefaults(microphonesQueries.list.key, { staleTime: 0 });

queryClient.setMutationDefaults(['recordings'], {
	scope: { id: 'recordings' },
});
queryClient.setMutationDefaults(['settings'], { scope: { id: 'settings' } });
queryClient.setMutationDefaults(['textFiles'], {
	scope: { id: 'textFiles' },
});
// A mutation keeps its input for `gcTime` after it settles; a key write keeps
// the typed API key, so it is dropped the moment nothing observes it.
queryClient.setMutationDefaults(['keys'], { scope: { id: 'keys' }, gcTime: 0 });
