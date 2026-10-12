/**
 * Plain-language status lines for the header, its status details, and the
 * outcome toasts. Saved files, changes since the last version, versions,
 * pushes, and an incoming update that has not finished are separate facts;
 * each line reports one of them, including unknown and out-of-date
 * observations. A save is never a version (ADR-0529), so the count of
 * changes since the last version is neutral detail. Times are the absolute
 * times an observation or attempt happened, so they never go stale on
 * screen.
 */
import type {
	CommitOutcome,
	GitError,
	GitSnapshot,
	PullError,
	PushOutcome,
	RecoverOutcome,
	SyncError,
	SyncOutcome,
} from '@epicenter/folder';
import { describeSync } from '@epicenter/svelte/sync-line';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodosError } from './session.js';

export type Tone = 'neutral' | 'busy' | 'good' | 'warning' | 'error';
export type StatusLine = {
	readonly label: string;
	/** A compact label for narrow screens, when `label` is long. */
	readonly short?: string;
	readonly detail?: string;
	readonly tone: Tone;
};

/** Guidance when local and remote each have versions the other lacks. */
export const DIVERGED =
	'Local and remote history have diverged; local versions are kept. Sync combines them.';

/** Why Sync and Save version wait while an incoming update is pending. */
export const INCOMING_WAITS =
	'An incoming update from the remote has not finished. Sync and Save version wait until you recover it; nothing was changed. You can still edit and save files.';

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

/** Whether the last remote check saw commits on both sides. */
function diverged(git: GitSnapshot) {
	return (
		git.sync.state === 'observed' &&
		git.sync.value.ahead > 0 &&
		git.sync.value.behind > 0
	);
}

/** Whether every edit is in its file. Writes run as you type; a save is never a version. */
export function filesLine({ saving }: { saving: boolean }): StatusLine {
	return saving
		? { label: 'Saving…', tone: 'busy' }
		: { label: 'Saved', tone: 'good' };
}

function changesLabel(count: number) {
	return count === 0
		? 'No changes since the last version'
		: `${count} ${count === 1 ? 'change' : 'changes'} since the last version`;
}

/**
 * Changes since the last version: neutral detail, since saves never make
 * versions. Only a current, successful observation counts them; a stale or
 * failed one says it needs checking and names what the last check saw.
 */
export function versionLine(git: GitSnapshot): StatusLine {
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

/** One Save version, as the last-version line and its toast report it. */
export function versionOutcomeLine(outcome: CommitOutcome): StatusLine {
	switch (outcome.status) {
		case 'committed':
			return outcome.indexWarning
				? {
						label: `Saved version ${short(outcome.oid)} · index not updated`,
						short: 'Index issue',
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
						short: 'Index issue',
						detail: `${outcome.indexWarning}\nSave version retries it.`,
						tone: 'warning',
					}
				: { label: 'No changes since the last version', tone: 'neutral' };
		case 'branchMoved':
			return {
				label: 'Version not saved',
				short: 'Not saved',
				detail:
					'The branch changed while saving the version. Your files are saved; save the version again.',
				tone: 'warning',
			};
		case 'blocked':
			return {
				label: 'Version not saved',
				detail: outcome.reason,
				tone: 'warning',
			};
		case 'failed':
			return {
				label: 'Version not saved',
				detail: `${outcome.error}\nYour files are still saved.`,
				tone: 'error',
			};
		case 'unconfirmed':
			return {
				label: 'Version not confirmed',
				detail: outcome.error,
				tone: 'warning',
			};
		case 'stoppedWaiting':
			return { label: 'Version may still be saving', tone: 'neutral' };
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

/** The last version this session: Save version, or the checkpoint a Sync made. */
export function lastVersionLine(git: GitSnapshot): StatusLine {
	if (git.activity.commit.active)
		return { label: 'Saving version…', tone: 'busy' };
	const last = git.lastCommit;
	if (last === undefined)
		return { label: 'No version saved this session', tone: 'neutral' };
	return withTime(versionOutcomeLine(last), 'Last attempt', last.at);
}

/**
 * One push attempt. A rejected push while the last check saw divergence
 * reports the divergence, not the transport's message.
 */
function pushOutcomeLine(outcome: PushOutcome, git: GitSnapshot): StatusLine {
	switch (outcome.status) {
		case 'pushed':
			return { label: `Pushed ${short(outcome.oid)}`, tone: 'good' };
		case 'failed':
			return diverged(git)
				? {
						label: 'Push failed',
						short: 'Diverged',
						detail: DIVERGED,
						tone: 'error',
					}
				: {
						label: 'Push failed',
						detail: `${outcome.error}\nLocal commits are kept.`,
						tone: 'error',
					};
		case 'noRemote':
			return { label: 'No remote configured', tone: 'neutral' };
		case 'unconfirmed':
			return {
				label: 'Push not confirmed',
				detail: outcome.error,
				tone: 'warning',
			};
		case 'nothingToPush':
			return { label: 'Nothing to push yet', tone: 'neutral' };
		case 'skipped':
			return {
				label: 'Push skipped',
				detail: outcome.reason,
				tone: 'neutral',
			};
		case 'cancelled':
			return { label: 'Push cancelled', tone: 'neutral' };
		case 'stoppedWaiting':
			return { label: 'Push may still be running', tone: 'neutral' };
		case 'closed':
			return { label: 'Closed', tone: 'neutral' };
	}
}

export function pushLine(git: GitSnapshot): StatusLine {
	if (git.remote === undefined)
		return {
			label: 'No remote',
			detail:
				'This folder has no Git remote. Versions stay on this computer; nothing is sent or received.',
			tone: 'neutral',
		};
	if (git.activity.push.active) return { label: 'Pushing…', tone: 'busy' };
	if (git.activity.fetch.active) return { label: 'Fetching…', tone: 'busy' };
	if (git.activity.merge.active) return { label: 'Merging…', tone: 'busy' };
	const sync = git.sync.state === 'observed' ? git.sync.value : undefined;
	const last = git.lastPush;
	const parts: string[] = [];
	if (sync && sync.ahead > 0) parts.push(`${sync.ahead} not pushed`);
	if (sync && sync.behind > 0) parts.push(`${sync.behind} incoming`);
	const counts = parts.join(', ');
	if (last?.status === 'failed') {
		const line = withTime(pushOutcomeLine(last, git), 'Last attempt', last.at);
		return counts ? { ...line, label: `Push failed · ${counts}` } : line;
	}
	if (git.sync.state === 'unknown')
		return git.sync.error
			? {
					label: 'Remote check failed',
					short: 'Check failed',
					detail: git.sync.error,
					tone: 'error',
				}
			: {
					label: 'Sync not checked yet',
					short: 'Not checked',
					tone: 'neutral',
				};
	const seen = `Remote ${short(git.sync.value.remote)} · local ${short(git.sync.value.head)}, as of ${at(git.sync.checkedAt)}`;
	if (git.sync.error)
		return {
			label: 'Remote check failed',
			short: 'Check failed',
			detail: `${git.sync.error}\nLast seen: ${seen}`,
			tone: 'error',
		};
	if (git.sync.value.head === undefined)
		return { label: 'No versions yet', short: 'No versions', tone: 'neutral' };
	if (git.sync.value.remote === undefined)
		return {
			label: 'Not pushed yet',
			short: 'Not pushed',
			detail: 'The remote has no record of this branch',
			tone: 'warning',
		};
	if (diverged(git))
		return {
			label: `Diverged · ${counts}`,
			short: 'Diverged',
			detail: `${DIVERGED}\n${seen}`,
			tone: 'error',
		};
	if (counts)
		return {
			label: counts,
			short:
				git.sync.value.ahead > 0
					? `${git.sync.value.ahead} to push`
					: `${git.sync.value.behind} incoming`,
			detail: seen,
			tone: 'warning',
		};
	return {
		label: 'Matches the remote as last seen',
		detail:
			last?.status === 'pushed' && last.oid === git.sync.value.head
				? `${seen}\nPushed at ${at(last.at)}`
				: seen,
		tone: 'good',
	};
}

/**
 * The incoming update that began and has not been recovered, as the folder
 * last read it; undefined when there is none. It is reported, never resumed:
 * only the person's Recover incoming update request does that.
 */
export function incomingLine(git: GitSnapshot): StatusLine | undefined {
	const pending = git.pendingIncoming;
	if (pending === undefined) return undefined;
	switch (pending.state) {
		case 'recorded':
			return {
				label: 'Incoming update not finished',
				short: 'Update pending',
				detail: `An update from the remote (${short(pending.expectedHead)} → ${short(pending.nextHead)} on ${pending.branch}) stopped partway, and some files may already hold its changes. Sync and Save version wait until you recover it. You can still edit and save files.`,
				tone: 'error',
			};
		case 'unadmitted':
			return {
				label: 'Incoming update never started',
				short: 'Update pending',
				detail:
					'An update from the remote was interrupted before it changed any file. Recovering clears its record. Sync and Save version wait until then.',
				tone: 'error',
			};
		case 'unreadable':
			return {
				label: 'Incoming update record unreadable',
				short: 'Update pending',
				detail: `The record of an incoming update cannot be read: ${pending.reason}. Recovery reports what it finds and writes nothing it cannot verify. Sync and Save version wait until it is recovered.`,
				tone: 'error',
			};
	}
}

/** What one Recover incoming update request did, for its toast and the pending report. */
export function recoveryLine({
	data: outcome,
	error,
}: Result<RecoverOutcome, PullError | GitError | TodosError>): StatusLine {
	if (error === null)
		switch (outcome.status) {
			case 'none':
				return { label: 'No incoming update was pending', tone: 'neutral' };
			case 'admissionCleared':
				return {
					label: 'Incoming update cleared',
					detail:
						'It never changed a file. Sync and Save version can continue.',
					tone: 'good',
				};
			case 'cleared':
				return {
					label: 'Incoming update cleared',
					detail:
						'History already had it, so no file was written. Check the changes before saving a version.',
					tone: 'good',
				};
			case 'completed':
				return {
					label: `Incoming update finished: ${outcome.changedPaths.length} ${outcome.changedPaths.length === 1 ? 'file' : 'files'}`,
					detail: outcome.changedPaths.join('\n') || undefined,
					tone: 'good',
				};
		}
	switch (error.name) {
		case 'NotStarted':
			return {
				label: 'Recovery waits',
				detail: `${error.reason} Nothing was changed.`,
				tone: 'neutral',
			};
		case 'RecoveryRefused':
			return {
				label: 'Incoming update not recovered',
				short: 'Not recovered',
				detail: `${error.reason}\nThese hold neither the version before the update nor after it:\n${error.paths.join('\n')}\nNothing was written, and the update is still pending. Change each to one of those versions, then recover again.`,
				tone: 'error',
			};
		case 'Partial':
			return {
				label: 'Recovery stopped partway',
				detail: `${error.message}\nThe update is still pending; recover again.`,
				tone: 'error',
			};
		case 'Unconfirmed':
			return {
				label: 'Recovery not confirmed',
				detail: `${error.message}\nIt may or may not have finished; the folder reports which. Recover again if it is still pending.`,
				tone: 'warning',
			};
		default:
			return {
				label: 'Recovery stopped',
				detail: `${error.message}\nThe update is still pending.`,
				tone: 'error',
			};
	}
}

/**
 * One Sync or one Apply in the sync review, in the shared wording
 * (`describeSync`), with Todos' own words for a pending incoming update and
 * for the push of a merge that is not synced yet.
 */
export function syncOutcomeLine(
	result: Result<SyncOutcome, SyncError | TodosError>,
	git: GitSnapshot,
): StatusLine {
	const { data, error } = result;
	if (error?.name === 'NotStarted')
		return {
			label: 'Sync did not start',
			detail: error.reason,
			tone: 'warning',
		};
	// A pending incoming update refuses the checkpoint first, or the merge.
	const waits =
		(error?.name === 'Merge' && error.error.name === 'IncomingPending') ||
		(error?.name === 'Checkpoint' &&
			error.outcome.status === 'blocked' &&
			git.pendingIncoming !== undefined);
	if (waits)
		return { label: 'Sync waits', detail: INCOMING_WAITS, tone: 'warning' };
	return describeSync(error === null ? Ok(data) : Err(error), (push) => {
		const line = pushOutcomeLine(push, git);
		return [line.label, line.detail].filter(Boolean).join('\n');
	});
}

/**
 * The one line the header shows: the most severe current fact, the earlier
 * one on a tie. The last version attempt counts only when it needs
 * attention; changes since the last version are neutral detail and never
 * lead. When nothing needs attention, the folder is saved and matches the
 * remote as last seen.
 */
export function summaryLine(lines: {
	files: StatusLine;
	/** A pending incoming update; it outranks every other fact it ties with. */
	incoming?: StatusLine;
	versions: StatusLine;
	lastVersion: StatusLine;
	remote: StatusLine;
}): StatusLine {
	let chosen: StatusLine | undefined;
	for (const line of [
		lines.incoming,
		lines.files,
		lines.versions,
		lines.lastVersion,
		lines.remote,
	])
		if (
			line &&
			(chosen === undefined || SEVERITY[line.tone] > SEVERITY[chosen.tone])
		)
			chosen = line;
	if (
		chosen === undefined ||
		chosen.tone === 'good' ||
		chosen.tone === 'neutral'
	)
		return { label: 'Up to date', tone: 'good' };
	return chosen;
}
