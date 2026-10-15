/**
 * Plain-language status lines for the header and its details.
 *
 * Saved files and history are separate facts and each line reports one: a
 * recording can be saved while its commit is pending, failed, or blocked, and
 * a failed commit never turns a saved file into an unsaved one. Times are the
 * absolute times an observation or attempt happened, so they never go stale on
 * screen.
 */
import type { CommitOutcome, GitSnapshot } from '@epicenter/folder';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';
export type StatusLine = {
	readonly label: string;
	/** A compact label for narrow windows, when `label` is long. */
	readonly short?: string;
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

function withTime(
	line: StatusLine,
	event: 'Checked' | 'Last attempt',
	time: number,
): StatusLine {
	const when = `${event} at ${at(time)}`;
	return { ...line, detail: line.detail ? `${line.detail}\n${when}` : when };
}

/** What is saved to files: edits being written, and answers whose write failed. */
export function filesLine(state: {
	saving: boolean;
	/** Answers that arrived and whose result file could not be written yet. */
	unwrittenAnswers: number;
}): StatusLine {
	const unwritten = state.unwrittenAnswers;
	if (unwritten > 0)
		return {
			label: `${unwritten} ${unwritten === 1 ? 'answer' : 'answers'} not written yet`,
			short: 'Answer not written',
			detail:
				'Whispering keeps writing it while this window is open. If the window closes first, its file stays without the answer, and you can run it again.',
			tone: 'error',
		};
	if (state.saving) return { label: 'Saving…', tone: 'busy' };
	return { label: 'All changes saved to files', short: 'Saved', tone: 'good' };
}

/** The files line for the product state, as the header shows it. */
export function filesLineOf(library: {
	readonly saving: boolean;
	readonly unwrittenAnswers: number;
}): StatusLine {
	return filesLine({
		saving: library.saving,
		unwrittenAnswers: library.unwrittenAnswers,
	});
}

function changesLabel(count: number) {
	return count === 0
		? 'No changes since the last version'
		: `${count} ${count === 1 ? 'change' : 'changes'} since the last version`;
}

/**
 * Saved files that are in no saved version yet. A count is neutral detail,
 * not a warning (ADR-0529). Only a current, successful observation may say
 * there are none; a stale or failed one says it needs checking and names
 * what the last check saw.
 */
export function uncommittedLine(git: GitSnapshot): StatusLine {
	const files = git.files;
	if (files.state === 'unknown')
		return files.error
			? {
					label: 'Check failed',
					detail: `Uncommitted changes are unknown: ${files.error}`,
					tone: 'error',
				}
			: git.activity.scan.active
				? { label: 'Checking…', tone: 'busy' }
				: {
						label: 'Changes not checked yet',
						short: 'Not checked',
						tone: 'neutral',
					};
	const count = files.value.changes.length;
	const last = `Last check at ${at(files.checkedAt)}: ${changesLabel(count).toLowerCase()}`;
	if (files.error)
		return {
			label: 'Check failed',
			detail: `${files.error}\n${last}`,
			tone: 'error',
		};
	if (files.stale)
		return git.activity.scan.active
			? { label: 'Checking…', detail: last, tone: 'busy' }
			: {
					label: 'Changes need checking',
					short: 'Needs check',
					detail: `Files changed after the last check. ${last}`,
					tone: 'neutral',
				};
	const changes = files.value.changes
		.slice(0, 8)
		.map(
			(change) =>
				`${change.kind === 'add' ? 'new' : change.kind === 'delete' ? 'deleted' : 'modified'} ${change.path}`,
		);
	return withTime(
		{
			label: changesLabel(count),
			short: count === 0 ? undefined : `${count} changed`,
			detail: changes.join('\n') || undefined,
			tone: count === 0 ? 'good' : 'neutral',
		},
		'Checked',
		files.checkedAt,
	);
}

/** One commit attempt, as the last-version line and the Save version toast report it. */
export function commitOutcomeLine(outcome: CommitOutcome): StatusLine {
	switch (outcome.status) {
		case 'committed':
			return outcome.indexWarning
				? {
						label: `Committed ${short(outcome.oid)} · index not updated`,
						short: 'Index issue',
						detail: `${outcome.message}\nIndex not updated: ${outcome.indexWarning}`,
						tone: 'warning',
					}
				: {
						label: `Committed ${short(outcome.oid)}`,
						detail: outcome.message,
						tone: 'good',
					};
		case 'unchanged':
			return outcome.indexWarning
				? {
						label: 'Git index not updated',
						short: 'Index issue',
						detail: `${outcome.indexWarning}\nSave version retries it.`,
						tone: 'warning',
					}
				: { label: 'Nothing new to commit', tone: 'neutral' };
		case 'branchMoved':
			return {
				label: 'Commit not recorded',
				short: 'Not committed',
				detail:
					'The branch changed while committing. Your files are saved; commit again.',
				tone: 'warning',
			};
		case 'blocked':
			return {
				label: 'Commit blocked',
				detail: `${outcome.reason}\nYour files are still saved.`,
				tone: 'warning',
			};
		case 'failed':
			return {
				label: 'Commit failed',
				detail: `${outcome.error}\nYour files are still saved. Save version tries again.`,
				tone: 'error',
			};
		case 'unconfirmed':
			return {
				label: 'Commit not confirmed',
				detail: outcome.error,
				tone: 'warning',
			};
		case 'stoppedWaiting':
			return { label: 'Commit may still be running', tone: 'neutral' };
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

export function commitLine(git: GitSnapshot): StatusLine {
	if (git.activity.commit.active) return { label: 'Committing…', tone: 'busy' };
	const last = git.lastCommit;
	if (last === undefined)
		return { label: 'No commit this session', tone: 'neutral' };
	return withTime(commitOutcomeLine(last), 'Last attempt', last.at);
}

/** The committed head, as last observed. */
export function headLine(git: GitSnapshot): StatusLine {
	const files = git.files;
	if (files.state === 'unknown')
		return files.error
			? { label: 'History unavailable', detail: files.error, tone: 'error' }
			: { label: 'History not checked yet', tone: 'neutral' };
	const line: StatusLine =
		files.value.head === undefined
			? { label: 'No commits yet', tone: 'neutral' }
			: {
					label: `${git.branch} at ${short(files.value.head)}`,
					tone: 'neutral',
				};
	if (!files.stale && !files.error) return line;
	return withTime(
		{
			...line,
			label: `Last observed: ${line.label}`,
			detail: files.error,
		},
		'Checked',
		files.checkedAt,
	);
}

/**
 * The one line the header shows: the most severe current fact, the earlier one
 * on a tie. Unsaved files take priority over history. The last commit attempt
 * and the changes since the last version count only when they need attention.
 */
export function summaryLine(lines: {
	files: StatusLine;
	uncommitted: StatusLine;
	commit: StatusLine;
}): StatusLine {
	if (lines.files.tone === 'busy' || lines.files.tone === 'error')
		return lines.files;
	const needsAttention = (line: StatusLine) =>
		line.tone !== 'neutral' && line.tone !== 'good';
	let chosen: StatusLine | undefined;
	for (const line of [
		lines.files,
		needsAttention(lines.commit) ? lines.commit : undefined,
		// How many files changed since the last version is detail, not news.
		needsAttention(lines.uncommitted) ? lines.uncommitted : undefined,
	])
		if (
			line &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	if (chosen === undefined || chosen.tone === 'good')
		return { label: 'Saved', tone: 'good' };
	if (chosen === lines.commit)
		return { ...chosen, label: `Saved · ${chosen.label.toLowerCase()}` };
	return chosen;
}

/**
 * Whether one saved file is in history. `undefined` when the last check cannot
 * answer, so a row never claims a commit it has not seen.
 */
export function committedState(
	git: GitSnapshot,
	paths: readonly string[],
): 'committed' | 'uncommitted' | undefined {
	if (git.files.state !== 'observed' || git.files.stale || git.files.error)
		return undefined;
	const changed = new Set(git.files.value.changes.map((change) => change.path));
	return paths.some((path) => changed.has(path)) ? 'uncommitted' : 'committed';
}
