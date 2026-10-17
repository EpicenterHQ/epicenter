/**
 * `todos.git`: the folder's Git state, its status, and the version actions
 * a person asks for. Saves never commit (ADR-0529): a version is recorded by
 * Save version or by Sync.
 */
import type { FilesObservation, GitError } from '@epicenter/folder';
import { createSubscriber } from 'svelte/reactivity';
import type { Result } from 'wellcrafted/result';
import type { TodosParts } from './todos.svelte.js';

export function createGit({
	folder,
	queries,
	edits,
	defineQuery,
	defineMutation,
}: TodosParts) {
	const trackSnapshot = createSubscriber((update) =>
		folder.git.subscribe(update),
	);
	return {
		/** What the folder knows of its history and remote, read reactively. */
		get snapshot() {
			trackSnapshot();
			return folder.git.snapshot;
		},
		/**
		 * Git status: changes since the last version, and local and remote
		 * heads. Keyed as the folder's own status query, so every change the
		 * folder reports marks it stale.
		 */
		status: defineQuery({
			queryKey: queries.history.status.queryKey(),
			queryFn: (): Promise<Result<FilesObservation, GitError>> =>
				folder.git.status(),
		}),
		/**
		 * Record a version: commit the saved files. What is typed and the
		 * writes still running land first. Never pushes.
		 */
		saveVersion: defineMutation({
			mutationKey: ['todos', 'save-version'],
			mutationFn: () => edits.saveVersion(),
		}),
	};
}
