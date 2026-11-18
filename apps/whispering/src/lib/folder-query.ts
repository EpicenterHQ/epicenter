/**
 * Whispering's folder as TanStack Query observes it: one `QueryClient` for
 * the page, its one rule that every query goes stale after every write, the
 * folder as one query, and the folder's writes as mutations.
 *
 * - The folder query answers the snapshot `folder.read()` makes. It never
 *   goes stale by time: a write makes it stale (the `MutationCache` rule),
 *   and the window regaining focus reads it again, since another program
 *   may write the folder. A read that a write overtakes is cancelled and
 *   read again, so the folder shown is never older than a finished write.
 * - A note's writes share a scope with the other writes of its kind, so
 *   they run one at a time, in the order made. Each carries the text that
 *   was shown (`seen`), and is refused when the file differs. A write that
 *   settles keeps pending until the folder on screen has been read again.
 * - `settings` is `settings.md` for code that is not a component (the
 *   connections `ai` merges, the global shortcut, the model choices
 *   Whispering reads): it reads the folder query's answer and says when it
 *   changes, and writes through the client.
 *
 * Nothing here is Svelte; components observe these options with
 * `@tanstack/svelte-query`.
 */
import type { ConnectionStore, ModelChoice } from '@epicenter/ai';
import { MutationCache, QueryClient } from '@tanstack/query-core';
import { resultMutations, resultQueries, runMutation } from 'wellcrafted/query';
import type { NoteName, NoteRef, WhisperingFolder } from './folder.js';
import type { NOTES } from './format/folder.js';
import type { IdCollection, NotePatch, Notes } from './notes.js';
import {
	chosenIn,
	connectionsIn,
	type Job,
	NO_SETTINGS,
	type SettingsSnapshot,
	shortcutIn,
} from './settings.js';

type Collections = typeof NOTES;

/** `writes`, each in scope `id`, so they run one at a time in the order made. */
const inScope = <T extends Record<string, object>>(id: string, writes: T): T =>
	Object.fromEntries(
		Object.entries(writes).map(([name, write]) => [
			name,
			{ ...write, scope: { id } },
		]),
	) as T;

/** A kind's writes, in the kind's scope. */
const noteMutationsOf = <C extends IdCollection>(
	kind: NoteName,
	notes: Notes<C>,
) =>
	inScope(
		kind,
		resultMutations(['notes', kind], {
			set: notes.set,
			replace: notes.replace,
			delete: notes.delete,
		}),
	);

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
	queryClient.setQueryDefaults(folderQueries.read.key, {
		staleTime: Number.POSITIVE_INFINITY,
		refetchOnWindowFocus: 'always',
	});

	const { notes } = folder;
	const noteMutations = {
		recordings: noteMutationsOf('recordings', notes.recordings),
		transcriptions: noteMutationsOf('transcriptions', notes.transcriptions),
	};

	const settingsMutations = inScope(
		'settings',
		resultMutations(['settings'], {
			setChoice: folder.settings.setChoice,
			setConnections: folder.settings.setConnections,
			setShortcut: folder.settings.setShortcut,
		}),
	);
	// Audio is in `recordings/`, and deleting old audio writes recordings' notes.
	const audioMutations = inScope(
		'recordings',
		resultMutations(['audio'], {
			delete: folder.deleteAudio,
			deleteBefore: folder.deleteAudioBefore,
		}),
	);

	/** The folder as last read, or undefined before the first read answers. */
	const snapshot = () =>
		queryClient.getQueryData(folderQueries.read().queryKey);
	const settingsNow = (): SettingsSnapshot =>
		snapshot()?.settings ?? NO_SETTINGS;
	/** Note `id` of `kind` as last read, which a write of it says was seen. */
	const seenOf = (kind: NoteName, id: string) =>
		snapshot()?.[kind].texts[id] ?? null;

	/**
	 * Call `listener` whenever the settings read differ; returns the
	 * unsubscribe. A read that finds them unchanged keeps the same object
	 * (TanStack's structural sharing), so it calls nothing.
	 */
	function subscribe(listener: () => void): () => void {
		let last = settingsNow();
		return queryClient.getQueryCache().subscribe(() => {
			const now = settingsNow();
			if (now === last) return;
			last = now;
			listener();
		});
	}

	const connections: ConnectionStore = {
		list: () => connectionsIn(settingsNow()),
		problem: () => {
			const { problem } = settingsNow();
			return problem === null
				? null
				: { message: `settings.md does not read (${problem})` };
		},
		async save(list) {
			const saved = await runMutation(
				queryClient,
				settingsMutations.setConnections,
				{ seen: settingsNow().text, connections: list },
			);
			if (saved.error !== null) throw new Error(saved.error.message);
		},
		subscribe,
	};

	const settings = {
		/** Why `settings.md` does not read, or null. */
		problem: (): string | null => settingsNow().problem,
		/** The model chosen for each job. */
		choices: {
			/** The model chosen for `job`, or null. */
			get: (job: Job): ModelChoice | null =>
				chosenIn(settingsNow(), job).data ?? null,
			/** The model chosen for `job`, for an action that decides on it: why there is none. */
			require: (job: Job) => chosenIn(settingsNow(), job),
			/** Choose `choice` for `job`; replaces a `settings.md` that does not read. */
			set: (job: Job, choice: ModelChoice) =>
				runMutation(queryClient, settingsMutations.setChoice, {
					seen: settingsNow().text,
					job,
					choice,
				}),
		},
		/** The connections, for `customEndpoints`. */
		connections,
		/** The global shortcut, in the global-shortcut plugin's spelling. */
		shortcut: (): string => shortcutIn(settingsNow()),
		/** Make `key` the global shortcut. */
		setShortcut: (key: string) =>
			runMutation(queryClient, settingsMutations.setShortcut, {
				seen: settingsNow().text,
				key,
			}),
		subscribe,
	};

	return {
		queryClient,
		folder,
		/**
		 * Give note `id` of `kind` `changes`, over the note as last read: it is
		 * refused when the file changed since. A note not yet listed is made.
		 */
		setNote: <K extends NoteName>(
			kind: K,
			id: string,
			changes: NotePatch<Collections[K]>,
		) =>
			runMutation(
				queryClient,
				// Every kind's `set` takes its own fields; `kind` picks which.
				noteMutations[kind].set as unknown as SetNote,
				{ id, seen: seenOf(kind, id), changes: changes as Changes },
			),
		/** Remove note `ref`, as last read: refused when the file changed since. */
		removeNote: ({ collection, id }: NoteRef) =>
			runMutation(queryClient, noteMutations[collection].delete, {
				id,
				seen: seenOf(collection, id),
			}),
		/** Delete recording `id`'s audio files. */
		deleteAudio: (id: string) =>
			runMutation(queryClient, audioMutations.delete, { id }),
		/**
		 * Read the folder again after something that is not a mutation wrote
		 * it: audio the recorder placed.
		 */
		reread: () =>
			queryClient.invalidateQueries({ queryKey: folderQueries.read.key }),
		folderQueries,
		noteMutations,
		audioMutations,
		snapshot,
		settings,
	};
}

type SetNote = ReturnType<
	typeof noteMutationsOf<Collections['recordings']>
>['set'];
type Changes = NotePatch<Collections['recordings']>;

export type FolderQuery = ReturnType<typeof createFolderQuery>;
export type Settings = FolderQuery['settings'];
