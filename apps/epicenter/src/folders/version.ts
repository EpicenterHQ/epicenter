/**
 * What the Folders window says about Save version and about changes not yet
 * in a version. A version is a commit, made only when a person asks
 * (ADR-0529); edits are saved to files at once either way.
 */

import type { CommitOutcome, FilesObservation } from '@epicenter/folder';

/** A line for a person, and whether it reports a problem. */
export type VersionLine = {
	readonly text: string;
	readonly problem: boolean;
};

/** What one Save version did. */
export function versionMessage(outcome: CommitOutcome): VersionLine {
	switch (outcome.status) {
		case 'committed':
			return {
				text:
					outcome.changedPaths === 1
						? 'Saved a version with 1 changed file.'
						: `Saved a version with ${outcome.changedPaths} changed files.`,
				problem: false,
			};
		case 'unchanged':
			return {
				text: 'Nothing new to save since the last version.',
				problem: false,
			};
		case 'branchMoved':
			return {
				text: 'Version not saved: the history changed while it was saving. Your files are saved; try again.',
				problem: true,
			};
		case 'blocked':
			return { text: `Version not saved: ${outcome.reason}`, problem: true };
		case 'failed':
			return { text: `Version not saved: ${outcome.error}`, problem: true };
		case 'unconfirmed':
			return {
				text: `The version may not have been saved: ${outcome.error}`,
				problem: true,
			};
		case 'stoppedWaiting':
			return { text: 'The version may still be saving.', problem: false };
		case 'closed':
			return { text: 'This folder was closed.', problem: false };
	}
}

/** How many files changed since the last version; `checking` while it is read again. */
export function changesMessage(
	files: FilesObservation,
	checking: boolean,
): string {
	const count = files.changes.length;
	const text =
		count === 0
			? 'No changes since the last version'
			: count === 1
				? '1 file changed since the last version'
				: `${count} files changed since the last version`;
	return checking ? `${text} (checking)` : text;
}
