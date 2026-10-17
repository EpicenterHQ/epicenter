/**
 * Plain wording for a `folder.sync` result (ADR-0576), for a toast or a
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
 * Plain wording for one run. `describePush` words the push of a
 * merge that is not synced yet, for a page with its own push wording.
 */
export function describeSync(
	{ data: outcome, error }: Result<SyncOutcome, SyncError>,
	describePush: (push: PushOutcome) => string | undefined = (push) =>
		push.status === 'failed' ? push.error : undefined,
): SyncLine {
	if (error) {
		switch (error.name) {
			case 'Unrelated':
				return {
					label: 'The remote has its own history',
					detail:
						'Nothing was changed. Combine them to keep both, or choose another remote.',
					tone: 'warning',
				};
			case 'KeptChanging':
				return {
					label: 'The remote kept changing',
					detail: 'Nothing was changed here. Sync again in a moment.',
					tone: 'warning',
				};
			case 'Blocked':
				return {
					label: 'Sync stopped',
					detail: error.reason,
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
