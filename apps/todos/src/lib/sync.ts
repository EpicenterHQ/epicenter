/**
 * `todos.sync`: commit the saved files, fetch, merge, and push. A sync whose
 * changes conflict fails with `NeedsChoices`; the review answers its attempt
 * with `apply`.
 */
import type {
	SyncAttempt,
	SyncChoices,
	SyncError,
	SyncOutcome,
} from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import type { Session, TodosError } from './session.js';

export function createSync({
	folder,
	defineMutation,
	writesSettled,
	invalidate,
}: Session) {
	return {
		/** Sync now. Writes still running land first. */
		run: defineMutation({
			mutationKey: ['todos', 'sync'],
			mutationFn: async (): Promise<
				Result<SyncOutcome, SyncError | TodosError>
			> => {
				await writesSettled();
				return folder.sync.run();
			},
			onSettled: () => invalidate(),
		}),
		/** Answer a sync's review. Refused choices are `InvalidChoices` and keep the attempt. */
		apply: defineMutation({
			mutationKey: ['todos', 'apply'],
			mutationFn: async ({
				attempt,
				choices,
			}: {
				attempt: SyncAttempt;
				choices: SyncChoices;
			}): Promise<Result<SyncOutcome, SyncError | TodosError>> => {
				await writesSettled();
				return folder.sync.resolve(attempt, choices);
			},
			onSettled: () => invalidate(),
		}),
	};
}
