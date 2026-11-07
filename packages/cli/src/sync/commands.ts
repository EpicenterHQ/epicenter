/**
 * `epicenter sync` and `clone` (ADR-0804, ADR-0822): a folder in the
 * Epicenter folder synced with its folder on the server by the functions
 * every Epicenter program composes, `syncFolder` and its kin from
 * `@epicenter/folder/platform`. The local side is the directory's store,
 * the remote the folder on the server, and the manifest the folder's
 * record at the Epicenter folder's root, `.epicenter/synced/<folder-id>.json`.
 * No Git runs on this computer: history is the server's, read by
 * `history.ts`.
 *
 * Which directory is which folder is proven across the whole Epicenter
 * folder (`identify`). A folder not proven its record's asks which folder it
 * is before it syncs: `join` answers with a folder the person holds,
 * `create` with a new one; with nothing it could be it becomes a new
 * folder, and with one match the person holds alone it joins that one. A
 * sync that would delete many files on the server stops until
 * `pushDeletions` or `restoreDeletions` says what they are.
 *
 * Exit codes: 0 synced, 1 a sync to run again, a file the repository
 * refused, a question, or deletions waiting for an answer, 2 what the
 * operation cannot use (no sign-in, no such folder, the server out of reach).
 */
import type { Static } from 'typebox';
import { basename, dirname, join, resolve } from 'node:path';
import {
	type Answer as Choice,
	cloneIntoHome,
	type Deletions,
	describeMembers,
	type FolderSync,
	firstPartyApps,
	listFolders,
	type Question,
	type RemoteAccount,
	syncEvery,
	syncFolder,
} from '@epicenter/folder/platform';
import { Err, Ok } from 'wellcrafted/result';
import { authContext } from '../auth.ts';
import { folderNameIn, homeRoot } from '../folder-commands.ts';
import type { ImplementationOf } from '../operation.ts';
import type {
	clone as cloneOperation,
	sync as syncOperation,
} from '../operations.ts';
import { count, writeErr, writeOut } from '../output.ts';
import { signedInAccount, signedInNow } from './account.ts';

type SyncOutput = Static<(typeof syncOperation)['output']>;
/** One folder's part of a sync: `{ sync }` or `{ question }`. */
type Line = {
	sync?: NonNullable<SyncOutput['sync']>;
	question?: NonNullable<SyncOutput['question']>;
};

/** The question a folder asks, as an output carries it. */
const questionOf = (question: Question) => ({
	folder: question.name,
	path: question.path,
	candidates: question.candidates.map(({ folder, matchedBy, alone }) => ({
		id: folder.id,
		title: folder.title,
		members: folder.members,
		matchedBy,
		alone,
	})),
	preselected: question.preselected,
	madeBy: question.madeBy?.client ?? null,
});

/** One folder's sync, as an output carries it, and whether a person acts on it. */
function lineOf(
	path: string,
	done: FolderSync,
): { line: Line; finding: boolean } {
	if (done.kind === 'git')
		return { line: { sync: { folder: path, git: true } }, finding: true };
	if (done.kind === 'question')
		return { line: { question: questionOf(done.question) }, finding: true };
	const { report } = done;
	return {
		line: {
			sync: {
				folder: path,
				id: done.folder,
				made: done.made,
				joined: done.joined,
				...report,
			},
		},
		finding: !(report.outcome === 'synced' && report.refused.length === 0),
	};
}

/** The first few of `paths`, and how many more. */
function some(paths: readonly string[]) {
	const shown = paths.slice(0, 3).join(', ');
	return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/** One folder's part, as a person reads it. */
function printLine({ sync, question }: Line) {
	if (question !== undefined) {
		const name = JSON.stringify(question.folder);
		writeErr(
			[
				`${question.folder} is not synced on this computer yet. It could be:`,
				...question.candidates.map(({ id, title, members, matchedBy }) => {
					const selected =
						id === question.preselected
							? '  (selected: it holds exactly the files it had when it last synced here)'
							: '';
					return `  ${id}  ${title ?? '(untitled)'}  ${describeMembers(members as never)}  (same ${matchedBy})${selected}`;
				}),
				'',
				`Sync it with one:   epicenter sync ${name} --join ${question.preselected ?? '<id>'}`,
				`Or as a new folder: epicenter sync ${name} --create`,
			].join('\n'),
		);
		return;
	}
	if (sync === undefined) return;
	const path = sync.folder;
	if (sync.git) {
		writeErr(
			`${path} is kept by Git, so Epicenter does not sync it: Git syncs it.`,
		);
		return;
	}
	if (sync.error !== undefined) {
		writeErr(`Could not sync ${path}: ${sync.error}`);
		return;
	}
	if (sync.outcome === undefined) return;
	if (sync.outcome === 'deletions') {
		const deletions = sync.deletions ?? [];
		writeErr(
			`${path}: this sync would delete ${count(deletions.length, 'file')} on the server (${some(deletions)}), so it sent nothing.\nRun epicenter sync ${JSON.stringify(basename(path))} --push-deletions to delete them there, or --restore-deletions to bring them back here.`,
		);
		return;
	}
	if (sync.made) writeErr(`${path}: its folder on the server is ${sync.id}`);
	if (sync.joined)
		writeErr(
			`${path}: synced with ${sync.id} for the first time; nothing was deleted on either side`,
		);
	const parts = [
		sync.pulled?.length ? `${count(sync.pulled.length, 'file')} pulled` : '',
		sync.pushed?.length ? `${count(sync.pushed.length, 'file')} pushed` : '',
		sync.merged?.length ? `${count(sync.merged.length, 'note')} merged` : '',
	].filter(Boolean);
	writeOut(
		`${path}: ${sync.outcome === 'synced' ? 'synced' : 'run sync again'}${parts.length > 0 ? ` (${parts.join(', ')})` : ', nothing changed'}`,
	);
	for (const conflict of sync.conflicts ?? [])
		writeErr(
			`${conflict}: both sides changed the same lines; fix the conflict markers`,
		);
	for (const kept of sync.kept ?? [])
		writeErr(`${kept}: changed while syncing; the next sync takes it`);
	for (const { path: refused, reason } of sync.refused ?? [])
		writeErr(`${refused}: refused: ${reason}`);
}

/** What `pushDeletions` or `restoreDeletions` says, or why both were given. */
function deletionsOf(input: {
	pushDeletions?: boolean;
	restoreDeletions?: boolean;
}): Deletions | undefined | { refused: string } {
	if (input.pushDeletions && input.restoreDeletions)
		return {
			refused: 'Give --push-deletions or --restore-deletions, not both.',
		};
	if (input.pushDeletions) return 'push';
	if (input.restoreDeletions) return 'restore';
	return undefined;
}

/** What `join` or `create` answers, or why both were given. */
function answerOf(input: {
	join?: string;
	create?: boolean;
}): Choice | undefined | { refused: string } {
	if (input.join !== undefined && input.create)
		return { refused: 'Give --join <id> or --create, not both.' };
	if (input.join !== undefined) return { join: input.join };
	if (input.create) return { create: true };
	return undefined;
}

/**
 * `epicenter sync [<folder>] [--join <id> | --create] [--push-deletions |
 * --restore-deletions]`: sync the folder (this directory by default) with
 * its folder on the server. `--all` syncs every folder in the Epicenter
 * folder that moved on either side.
 */
export const sync: ImplementationOf<typeof syncOperation> = {
	async run(input) {
		const deletions = deletionsOf(input);
		if (typeof deletions === 'object') return Err(deletions.refused);
		const answer = answerOf(input);
		if (answer !== undefined && 'refused' in answer) return Err(answer.refused);
		const signedIn = await signedInNow(authContext());
		if (signedIn.error !== null) return Err(signedIn.error);
		const account = signedIn.data;
		const root = homeRoot();
		if (input.all) {
			if (
				input.folder !== undefined ||
				answer !== undefined ||
				deletions !== undefined
			)
				return Err(
					'--all syncs every folder; name none, and answer each one by name.',
				);
			const every = await syncEvery({ account, root, apps: firstPartyApps() });
			if (every.error !== null) return Err(every.error.message);
			let finding = false;
			const lines: Line[] = [];
			for (const { path, result, waiting } of every.data.folders) {
				if (waiting === 'local' || waiting === 'git') {
					lines.push({ sync: { folder: path, waiting } });
					continue;
				}
				if (result === undefined) {
					lines.push({ sync: { folder: path, unchanged: true } });
					continue;
				}
				if (result.error !== null) {
					lines.push({ sync: { folder: path, error: result.error.message } });
					finding = true;
					continue;
				}
				const one = lineOf(path, result.data);
				lines.push(one.line);
				finding ||= one.finding;
			}
			return Ok({
				output: { every: lines, warnings: every.data.warnings },
				finding,
			});
		}
		const name = await folderNameIn(root, input.folder ?? '.');
		if (name.error !== null) return name;
		const done = await syncFolder({
			account,
			root,
			name: name.data,
			answer,
			deletions,
			apps: firstPartyApps(),
		});
		const path = join(root.path, name.data);
		if (done.error !== null)
			return Err(`Could not sync ${path}: ${done.error.message}`);
		const { line, finding } = lineOf(path, done.data);
		return Ok({ output: line, finding });
	},
	print(output) {
		for (const warning of output.warnings ?? []) writeErr(warning);
		if (output.every === undefined) {
			printLine(output);
			return;
		}
		for (const line of output.every) printLine(line);
		if (
			output.every.every(
				({ sync }) => sync?.waiting !== undefined || sync?.unchanged === true,
			)
		)
			writeOut('Every folder is in sync.');
	},
};

/**
 * The folder id `source` names among the folders the person holds: an id,
 * or a title, which must name one.
 */
async function folderOf(account: RemoteAccount, source: string) {
	const listing = await listFolders(account);
	if (listing.error !== null) return Err(listing.error.message);
	const found = listing.data.folders.filter(
		({ id, title }) => id === source || title === source,
	);
	if (found.length === 0)
		return Err(
			`You hold no folder '${source}': run epicenter clone to list yours`,
		);
	if (found.length > 1)
		return Err(
			`Several of your folders are titled '${source}': clone one by its id (${found.map(({ id }) => id).join(', ')})`,
		);
	return Ok(found[0] as (typeof found)[number]);
}

/**
 * `epicenter clone [<folder>] [<name>]`: without a folder, the folders the
 * person holds by title and who holds them; with one (its id or title),
 * bring it into a new folder in the Epicenter folder, named `<name>` or
 * for its title, and sync it from first contact, taking its files.
 */
export const clone: ImplementationOf<typeof cloneOperation> = {
	async run({ folder: source, name: dir }) {
		const account = signedInAccount(authContext());
		if (source === undefined) {
			const listing = await listFolders(account);
			if (listing.error !== null) return Err(listing.error.message);
			return Ok({ output: { folders: listing.data.folders } });
		}
		const named = await folderOf(account, source);
		if (named.error !== null) return named;
		const folder = named.data.id;
		const root = homeRoot();
		let name = named.data.title ?? folder;
		if (dir !== undefined) {
			if (dir.includes('/') && dirname(resolve(dir)) !== root.path)
				return Err(
					`${resolve(dir)} is not in ${root.path}: a folder is cloned into the Epicenter folder, by name.`,
				);
			name = basename(dir);
		}
		const cloned = await cloneIntoHome({ account, root, folder, name });
		if (cloned.error !== null) return Err(cloned.error.message);
		const { line, finding } = lineOf(cloned.data.local.path, cloned.data.sync);
		return Ok({ output: line, finding });
	},
	print(output) {
		if (output.folders === undefined) {
			printLine(output);
			return;
		}
		writeOut(
			output.folders.length === 0
				? 'You hold no folders yet.'
				: output.folders
						.map(
							({ id, title, members }) =>
								`${id}  ${title ?? '(untitled)'}  ${describeMembers(members as never)}`,
						)
						.join('\n'),
		);
	},
};
