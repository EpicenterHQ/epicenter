/**
 * Plain wording for a `folder.sync` result (ADR-0514), for a toast or a
 * status line. A plain module, so a page's status helpers can import it
 * without loading Svelte runes.
 */
import type { PushOutcome, SyncError, SyncOutcome } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';

/** A sync result as a person reads it. */
export type SyncLine = {
	readonly label: string;
	readonly detail?: string;
	readonly tone: 'good' | 'warning' | 'error';
};

/**
 * Plain wording for one run or Apply. `describePush` words the push of a
 * merge that is not synced yet, for a page with its own push wording.
 */
export function describeSync(
	{ data: outcome, error }: Result<SyncOutcome, SyncError>,
	describePush: (push: PushOutcome) => string | undefined = (push) =>
		push.status === 'failed' ? push.error : undefined,
): SyncLine {
	if (error) {
		switch (error.name) {
			case 'NeedsChoices':
				return {
					label: `${error.attempt.conflicts.length} ${error.attempt.conflicts.length === 1 ? 'change needs' : 'changes need'} your choice`,
					detail: 'Nothing was changed yet.',
					tone: 'warning',
				};
			case 'InvalidChoices':
				return {
					label: 'Some choices need a fix',
					detail:
						'Nothing was changed. Fix the marked results and apply again.',
					tone: 'warning',
				};
			case 'Stale':
				return {
					label: 'Sync again to review',
					detail: `${error.message}. Nothing was changed.`,
					tone: 'warning',
				};
			case 'Unrelated':
				return {
					label: 'The remote has its own history',
					detail:
						'Nothing was changed. Combine them to keep both, or choose another remote.',
					tone: 'warning',
				};
			case 'Unreviewable':
				return {
					label: 'Sync stopped: changes conflict',
					detail: `${error.message}. Nothing was changed. Resolve them with Git, then sync again.`,
					tone: 'error',
				};
			default:
				return { label: 'Sync stopped', detail: error.message, tone: 'error' };
		}
	}
	switch (outcome.kind) {
		case 'synced':
			return {
				label: 'Synced',
				detail: outcome.head.slice(0, 7),
				tone: 'good',
			};
		case 'saved':
			return {
				label: 'Merged here, not synced yet',
				detail: [
					outcome.push === undefined ? undefined : describePush(outcome.push),
					outcome.changedSince
						? 'Files were saved during the sync. Sync again to send them.'
						: 'Sync again to send it.',
				]
					.filter(Boolean)
					.join('\n'),
				tone: 'warning',
			};
	}
}
