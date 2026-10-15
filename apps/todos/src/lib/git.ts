/**
 * `todos.git`: the folder's Git state, its status, and the version actions
 * a person asks for. Saves never commit (ADR-0529): a version is recorded by
 * Save version or by Sync.
 */
import type {
	CommitOutcome,
	FilesObservation,
	GitError,
} from '@epicenter/folder';
import { createSubscriber } from 'svelte/reactivity';
import { Ok, type Result } from 'wellcrafted/result';
import { type Session, type TodosError, todosKeys } from './session.js';

export function createGit({
	folder,
	defineQuery,
	defineMutation,
	writesSettled,
	invalidate,
}: Session) {
	const trackSnapshot = createSubscriber((update) =>
		folder.git.subscribe(update),
	);
	return {
		/** What the folder knows of its history and remote, read reactively. */
		get snapshot() {
			trackSnapshot();
			return folder.git.snapshot;
		},
		/** Git status: changes since the last version, and local and remote heads. */
		status: defineQuery({
			queryKey: todosKeys.status,
			queryFn: (): Promise<Result<FilesObservation, GitError>> =>
				folder.git.status(),
		}),
		/**
		 * Record a version: commit the saved files. Writes still running land
		 * first. Never pushes.
		 */
		saveVersion: defineMutation({
			mutationKey: ['todos', 'save-version'],
			mutationFn: async (): Promise<Result<CommitOutcome, TodosError>> => {
				await writesSettled();
				return Ok(await folder.git.commit());
			},
			onSettled: () => invalidate(todosKeys.status),
		}),
	};
}
