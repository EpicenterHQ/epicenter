/**
 * Whispering's folder as TanStack Query observes it: one `QueryClient` for
 * the page, its one rule that every query goes stale after every write, two
 * queries, and the writes as mutations over the services, as they are.
 *
 * - The folder query answers the snapshot `folder.read()` makes of the
 *   notes and audio; the settings query answers `settings.md`. Neither goes
 *   stale by time: a write makes both stale (the `MutationCache` rule), and
 *   the window regaining focus reads them again, since another program may
 *   write the folder. A read that a write overtakes is cancelled and read
 *   again, so what is shown is never older than a finished write. A write
 *   that settles keeps pending until what is on screen has been read again.
 * - Every write `folderMutations` makes (to the notes, `settings.md`, and
 *   the audio) is keyed under `['folder']` and shares one scope, so they
 *   run one at a time, in the order made. A scope is a default by key
 *   prefix, so the mutations are the services' functions with nothing
 *   added. Two writes stay outside it: a transcription's transcript (its
 *   run is a `['runs']` mutation, whose request must not hold up every
 *   save) and the browser recorder's audio. Each writes a new file, so it
 *   never races a write the scope orders.
 * - `settings` is `settings.md` for the two readers that are not
 *   components: the connections `ai` merges (a `ConnectionStore`) and the
 *   global shortcut. Each reads the settings query's answer, hears it
 *   change through a `QueryObserver`, and writes through `set`.
 *
 * Nothing here is Svelte; components observe these options with
 * `@tanstack/svelte-query`.
 */
import type { ConnectionStore } from '@epicenter/ai';
import {
	MutationCache,
	QueryClient,
	QueryObserver,
} from '@tanstack/query-core';
import { resultMutations, resultQueries, runMutation } from 'wellcrafted/query';
import type { WhisperingFolder } from './folder.js';
import {
	connectionsIn,
	NO_SETTINGS,
	type SettingsSnapshot,
	shortcutIn,
} from './settings.js';

/** Read when a write made it stale or the window regains focus, never by time. */
const READ_ON_CHANGE = {
	staleTime: Number.POSITIVE_INFINITY,
	refetchOnWindowFocus: 'always',
} as const;

export function createFolderQuery(folder: WhisperingFolder) {
	const queryClient = new QueryClient({
		defaultOptions: {
			// The folder is on this device: reads and writes never wait for a network.
			queries: { networkMode: 'always', retry: false },
			mutations: { networkMode: 'always' },
		},
		mutationCache: new MutationCache({
			onSettled: (
				_data,
				_error,
				_variables,
				_rollback,
				_mutation,
				{ client },
			) => client.invalidateQueries(),
		}),
	});

	const folderQueries = resultQueries(['folder'], { read: folder.read });
	const settingsQueries = resultQueries(['settings'], {
		get: folder.settings.get,
	});
	queryClient.setQueryDefaults(folderQueries.read.key, READ_ON_CHANGE);
	queryClient.setQueryDefaults(settingsQueries.get.key, READ_ON_CHANGE);

	const { notes } = folder;
	const folderMutations = {
		notes: resultMutations(['folder', 'notes'], {
			set: notes.set,
			replace: notes.replace,
			delete: notes.delete,
		}),
		settings: resultMutations(['folder', 'settings'], {
			set: folder.settings.set,
		}),
		audio: resultMutations(['folder', 'audio'], {
			delete: folder.deleteAudio,
			deleteBefore: folder.deleteAudioBefore,
		}),
	};
	// Every write `folderMutations` makes runs in one scope, one at a time, in order.
	queryClient.setMutationDefaults(['folder'], { scope: { id: 'folder' } });

	/** The folder as last read, or undefined before the first read answers. */
	const snapshot = () =>
		queryClient.getQueryData(folderQueries.read().queryKey);
	/** `settings.md` as last read; no settings before the first read answers. */
	const settingsNow = (): SettingsSnapshot =>
		queryClient.getQueryData(settingsQueries.get().queryKey) ?? NO_SETTINGS;
	/** Change `settings.md`: the keys `patch` names, over the file as it is now. */
	const setSettings = (patch: Parameters<typeof folder.settings.set>[0]) =>
		runMutation(queryClient, folderMutations.settings.set, patch);

	/**
	 * Call `listener` whenever the settings read differ; answers the
	 * unsubscribe. Each listener has its own `QueryObserver`, as each
	 * component has its own `createQuery`, so it hears only changes made
	 * after it began. A read that finds them unchanged keeps the same object
	 * (TanStack's structural sharing), so it calls nothing.
	 */
	const followSettings = (listener: () => void) =>
		new QueryObserver(queryClient, {
			...settingsQueries.get(),
			notifyOnChangeProps: ['data'],
		}).subscribe(() => listener());

	const connections: ConnectionStore = {
		list: () => connectionsIn(settingsNow()),
		problem: () => {
			const { problem } = settingsNow();
			return problem === null
				? null
				: { message: `settings.md does not read (${problem})` };
		},
		async save(list) {
			const saved = await setSettings({
				connections: list.map((record) => ({ ...record })),
			});
			if (saved.error !== null) throw new Error(saved.error.message);
		},
		subscribe: followSettings,
	};

	const settings = {
		/** The connections, for `customEndpoints`. */
		connections,
		/** The global shortcut, in the global-shortcut plugin's spelling. */
		shortcut: {
			get: (): string => shortcutIn(settingsNow()),
			/** Make `key` the global shortcut. */
			set: (key: string) => setSettings({ shortcut: key }),
			subscribe: followSettings,
		},
	};

	return {
		queryClient,
		folder,
		/**
		 * Read the folder's notes and audio again after something that is not
		 * a mutation wrote them: audio the recorder placed.
		 */
		reread: () =>
			queryClient.invalidateQueries({ queryKey: folderQueries.read.key }),
		folderQueries,
		settingsQueries,
		folderMutations,
		snapshot,
		settings,
	};
}

export type FolderQuery = ReturnType<typeof createFolderQuery>;
/** `settings.md` as the global shortcut reads and changes it. */
export type ShortcutSettings = FolderQuery['settings']['shortcut'];
