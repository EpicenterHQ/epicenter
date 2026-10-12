/**
 * `todos.git`: the folder's Git state, its status, and the version actions
 * a person asks for. Saves never commit (ADR-0529): a version is recorded by
 * Save version or by Sync.
 */
import type {
	CommitOutcome,
	FilesObservation,
	GitError,
	PullError,
	RecoverOutcome,
} from '@epicenter/folder';
import { createSubscriber } from 'svelte/reactivity';
import { Ok, type Result } from 'wellcrafted/result';
import { type Session, type TodosError, todosKeys } from './session.js';

export function createGit({
	folder,
	queryClient,
	defineQuery,
	defineMutation,
	writesSettled,
	invalidate,
	trackMutations,
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
		/**
		 * Recover the incoming update in `snapshot.pendingIncoming`, only because
		 * the person asked. Writes still running land first; afterward every
		 * listing and open file is read again.
		 */
		recoverIncoming: defineMutation({
			mutationKey: todosKeys.recoverIncoming,
			mutationFn: async (): Promise<
				Result<RecoverOutcome, PullError | GitError | TodosError>
			> => {
				await writesSettled();
				return folder.git.recoverIncoming();
			},
			onSettled: () => invalidate(),
		}),
		/** Whether recovering an incoming update runs, read reactively. */
		get recovering() {
			trackMutations();
			return (
				queryClient.isMutating({ mutationKey: todosKeys.recoverIncoming }) > 0
			);
		},
	};
}
