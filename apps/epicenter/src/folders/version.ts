/**
 * What the Folders window says about Save version and about changes not yet
 * in a version. A version is a commit, made only when a person asks
 * (ADR-0529); edits are saved to files at once either way.
 */

import type {
	CommitOutcome,
	FilesObservation,
	GitInstall,
} from '@epicenter/folder';

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

/**
 * What the Folders window says when this computer has no `git` (ADR-0559):
 * files still open and save, and versions and Sync wait for it. `action`
 * labels the button that starts the install, where the shell can start one.
 */
export function gitMissingNotice(install: GitInstall): {
	readonly text: string;
	readonly action: string | undefined;
} {
	switch (install) {
		case 'command-line-tools':
			return {
				text: 'Saving versions and syncing need Git, which this Mac does not have yet. Your files still open and save. Installing the Command Line Tools adds Git; it takes a few minutes, once.',
				action: 'Install Command Line Tools',
			};
		case 'git-for-windows':
			return {
				text: 'Saving versions and syncing need Git, which this computer does not have yet. Your files still open and save. Install Git for Windows, then open this folder again.',
				action: 'Get Git for Windows',
			};
		case 'package-manager':
			return {
				text: "Saving versions and syncing need Git, which this computer does not have yet. Your files still open and save. Install git with your system's package manager, then open this folder again.",
				action: undefined,
			};
	}
}
