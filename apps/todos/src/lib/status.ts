/**
 * Plain-language status lines for the header, its status details, and the
 * outcome toasts. Saved files, changes since the last version, versions,
 * and pushes are separate facts; each line reports one of them, including unknown and out-of-date
 * observations. A save is never a version (ADR-0529), so the count of
 * changes since the last version is neutral detail. Times are the absolute
 * times an observation or attempt happened, so they never go stale on
 * screen.
 */
import type {
	CommitOutcome,
	GitSnapshot,
	PushOutcome,
	SyncError,
	SyncOutcome,
} from '@epicenter/folder';
import {
	changeList,
	localTime,
	mostSevere,
	type StatusLine,
	shortOid,
	withTime,
} from '@epicenter/svelte/status-line';
import { describeSync } from '@epicenter/svelte/sync-line';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { TodosError } from './session.js';

/** Guidance when local and remote each have versions the other lacks. */
export const DIVERGED =
	'Local and remote history have diverged; local versions are kept. Sync combines them.';

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
	const last = `Last check at ${localTime(files.checkedAt)}: ${changesLabel(count).toLowerCase()}`;
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
	return withTime(
		{
			label: changesLabel(count),
			short: count === 0 ? undefined : `${count} changed`,
			detail: changeList(files.value.changes).join('\n') || undefined,
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
						label: `Saved version ${shortOid(outcome.oid)} · index not updated`,
						short: 'Index issue',
						detail: `${outcome.message}\nIndex not updated: ${outcome.indexWarning}`,
						tone: 'warning',
					}
				: {
						label: `Saved version ${shortOid(outcome.oid)}`,
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
			return { label: `Pushed ${shortOid(outcome.oid)}`, tone: 'good' };
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

/**
 * A remote as a person recognizes it: Epicenter for a repository on the
 * server this build signs in to (`isEpicenter`), `owner/name` for a GitHub
 * repository, the demo remote by name, and any other URL as written.
 */
export function remoteLabel(
	url: string,
	isEpicenter: (url: string) => boolean = () => false,
): string {
	if (isEpicenter(url)) return 'Epicenter';
	const github = /^https:\/\/github\.com\/([^/]+\/[^/]+?)(?:\.git)?$/.exec(url);
	if (github) return github[1]!;
	if (/^https?:\/\/[^/]+\/git\/todos\.git$/.test(url)) return 'the demo remote';
	return url;
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
	const seen = `Remote ${shortOid(git.sync.value.remote)} · local ${shortOid(git.sync.value.head)}, as of ${localTime(git.sync.checkedAt)}`;
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
				? `${seen}\nPushed at ${localTime(last.at)}`
				: seen,
		tone: 'good',
	};
}

/**
 * One Sync or one Apply in the sync review, in the shared wording
 * (`describeSync`), with Todos' own words for the push of a merge that is
 * not synced yet.
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
	versions: StatusLine;
	lastVersion: StatusLine;
	remote: StatusLine;
}): StatusLine {
	const chosen = mostSevere([
		lines.files,
		lines.versions,
		lines.lastVersion,
		lines.remote,
	]);
	if (
		chosen === undefined ||
		chosen.tone === 'good' ||
		chosen.tone === 'neutral'
	)
		return { label: 'Up to date', tone: 'good' };
	return chosen;
}
