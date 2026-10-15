/**
 * Plain-language status lines for the header and its details.
 *
 * Saves, changes since the last version, and versions are three separate
 * facts, and each line reports exactly one: a save is an edit written to its
 * file, a change is a saved file that differs from the last version, and a
 * version is a commit (ADR-0529). Changes since the last version are neutral
 * detail, not a warning: nothing commits on its own. A failed commit is a
 * version fact; it never makes a saved file look unsaved.
 */
import type { CommitOutcome, GitSnapshot } from '@epicenter/folder';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';
export type StatusLine = {
	readonly label: string;
	readonly detail?: string;
	readonly tone: Tone;
};

const short = (oid: string | undefined) => oid?.slice(0, 7) ?? 'none';

function at(time: number) {
	const date = new Date(time);
	return date.toDateString() === new Date().toDateString()
		? date.toLocaleTimeString()
		: date.toLocaleString();
}

const SEVERITY: Record<Tone, number> = {
	error: 4,
	busy: 3,
	warning: 2,
	neutral: 1,
	good: 0,
};

/**
 * Saves: every edit is saved as it is made. A save that failed keeps the
 * edit on screen until it is saved again, so it stays news until then.
 */
export function savesLine(state: {
	saving: boolean;
	unsaved: boolean;
}): StatusLine {
	if (state.saving) return { label: 'Saving…', tone: 'busy' };
	if (state.unsaved)
		return {
			label: 'Not saved',
			detail:
				'A save failed. The edit is still on screen, and it saves again with your next change or Save again.',
			tone: 'error',
		};
	return { label: 'Saved', tone: 'good' };
}

function changesLabel(count: number) {
	return count === 0
		? 'Every file is in the last version'
		: `${count} ${count === 1 ? 'file' : 'files'} changed since the last version`;
}

/**
 * Saved files compared with the last version. Only a current, successful
 * check may say every file is in it.
 */
export function changesLine(git: GitSnapshot): StatusLine {
	const files = git.files;
	if (files.state === 'unknown')
		return files.error
			? {
					label: 'Check failed',
					detail: `Changes since the last version are unknown: ${files.error}`,
					tone: 'error',
				}
			: git.activity.scan.active
				? { label: 'Checking…', tone: 'busy' }
				: { label: 'Not checked yet', tone: 'neutral' };
	const count = files.value.changes.length;
	const last = `Last check at ${at(files.checkedAt)}: ${changesLabel(count).toLowerCase()}`;
	if (files.error)
		return {
			label: 'Check failed',
			detail: `${files.error}\n${last}`,
			tone: 'error',
		};
	if (files.stale)
		return git.activity.scan.active || git.activity.commit.active
			? { label: 'Checking…', detail: last, tone: 'busy' }
			: {
					label: 'Files changed since the last check',
					detail: last,
					tone: 'neutral',
				};
	const changes = files.value.changes
		.slice(0, 8)
		.map(
			(change) =>
				`${change.kind === 'add' ? 'new' : change.kind === 'delete' ? 'deleted' : 'modified'} ${change.path}`,
		);
	return {
		label: changesLabel(count),
		detail:
			[...changes, `Checked at ${at(files.checkedAt)}`].join('\n') || undefined,
		tone: count === 0 ? 'good' : 'neutral',
	};
}

/** One Save version outcome, as the header and its toast say it. */
export function commitOutcomeLine(outcome: CommitOutcome): StatusLine {
	switch (outcome.status) {
		case 'committed':
			return outcome.indexWarning
				? {
						label: `Saved version ${short(outcome.oid)} · index not updated`,
						detail: `${outcome.message}\nIndex not updated: ${outcome.indexWarning}`,
						tone: 'warning',
					}
				: {
						label: `Saved version ${short(outcome.oid)}`,
						detail: outcome.message,
						tone: 'good',
					};
		case 'unchanged':
			return outcome.indexWarning
				? {
						label: 'Git index not updated',
						detail: outcome.indexWarning,
						tone: 'warning',
					}
				: { label: 'Nothing new since the last version', tone: 'neutral' };
		case 'branchMoved':
			return {
				label: 'Version not saved',
				detail:
					'The branch changed while the version was being saved. Your files are saved; save a version again.',
				tone: 'warning',
			};
		case 'blocked':
			return {
				label: 'Version not saved',
				detail: `${outcome.reason}\nYour files are still saved.`,
				tone: 'warning',
			};
		case 'failed':
			return {
				label: 'Version failed',
				detail: `${outcome.error}\nYour files are still saved.`,
				tone: 'error',
			};
		case 'stoppedWaiting':
			return { label: 'Version may still be saving', tone: 'neutral' };
		case 'unconfirmed':
			return {
				label: 'Version reply was lost',
				detail: `${outcome.error}\nYour files are saved. Check history before saving a version again.`,
				tone: 'warning',
			};
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

/** Versions: the last Save version this session. */
export function historyLine(git: GitSnapshot): StatusLine {
	if (git.activity.commit.active)
		return { label: 'Saving a version…', tone: 'busy' };
	const last = git.lastCommit;
	if (last === undefined)
		return { label: 'No version saved this session', tone: 'neutral' };
	const line = commitOutcomeLine(last);
	const when = `Last attempt at ${at(last.at)}`;
	return { ...line, detail: line.detail ? `${line.detail}\n${when}` : when };
}

/**
 * The one line the header shows: the most severe current fact, the earlier
 * one on a tie. A neutral line is not news, so with nothing worse the header
 * says the files are saved.
 */
export function summaryLine(lines: {
	saves: StatusLine;
	changes: StatusLine;
	history: StatusLine;
}): StatusLine {
	let chosen: StatusLine | undefined;
	for (const line of [lines.saves, lines.changes, lines.history])
		if (
			line.tone !== 'neutral' &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	if (chosen === undefined || chosen.tone === 'good')
		return { label: 'Saved', tone: 'good' };
	return chosen;
}
