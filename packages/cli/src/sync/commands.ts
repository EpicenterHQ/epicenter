/**
 * `epicenter sync`, `clone`, `log`, `diff`, and `restore` (ADR-0804,
 * ADR-0822): a folder in the Epicenter folder synced with its folder on the
 * server by the functions every Epicenter program composes, `syncFolder`
 * and its kin from `@epicenter/folder/platform`. The local side is the
 * directory's store, the remote the folder's repository, and the manifest
 * the folder's record at the Epicenter folder's root,
 * `.epicenter/synced/<folder-id>.json`. No Git runs on this computer:
 * history is the server's, read here by `log` and `diff` and brought back
 * by `restore`.
 *
 * Which directory is which folder is proven across the whole Epicenter
 * folder (`identify`). A folder not proven its record's asks which folder it
 * is before it syncs: `--join <id>` answers with a folder the person holds,
 * `--create` with a new one; with nothing it could be it becomes a new
 * folder, and with one match the person holds alone it joins that one. A
 * sync that would delete many files on the server stops until
 * `--push-deletions` or `--restore-deletions` says what they are.
 *
 * Exit codes: 0 synced, 1 a sync to run again, a file the repository
 * refused, a question, or deletions waiting for an answer, 2 what the
 * command cannot use (no sign-in, no such folder, the server out of reach).
 */
import { basename, dirname, join, resolve } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import {
	type Answer,
	cloneIntoHome,
	type Deletions,
	describeMembers,
	type FolderSync,
	firstPartyApps,
	identify,
	listFolders,
	type Question,
	type RemoteAccount,
	syncEvery,
	syncFolder,
} from '@epicenter/folder/platform';
import { folderRepository } from '@epicenter/folder/sync';
import { Err, Ok } from 'wellcrafted/result';
import { authContext } from '../auth.ts';
import { folderNameIn, homeRoot } from '../folder-commands.ts';
import { count, EXIT, fail, writeErr, writeJson, writeOut } from '../output.ts';
import { signedInAccount, signedInNow } from './account.ts';

type Options = Record<string, string | true>;

/** The question a folder asks, as a person reads it, or as `--json` writes it. */
function printQuestion(question: Question, json: boolean) {
	if (json) {
		writeJson({
			question: {
				folder: question.name,
				path: question.path,
				candidates: question.candidates.map(
					({ folder, matchedBy, alone }) => ({
						id: folder.id,
						title: folder.title,
						members: folder.members,
						matchedBy,
						alone,
					}),
				),
				preselected: question.preselected,
				madeBy: question.madeBy?.client ?? null,
			},
		});
		return EXIT.finding;
	}
	const lines = [
		`${question.name} is not synced on this computer yet. It could be:`,
		...question.candidates.map(({ folder, matchedBy }) => {
			const selected =
				folder.id === question.preselected
					? '  (selected: it holds exactly the files it had when it last synced here)'
					: '';
			return `  ${folder.id}  ${folder.title ?? '(untitled)'}  ${describeMembers(folder.members)}  (same ${matchedBy})${selected}`;
		}),
		'',
		`Sync it with one:   epicenter sync ${JSON.stringify(question.name)} --join ${question.preselected ?? '<id>'}`,
		`Or as a new folder: epicenter sync ${JSON.stringify(question.name)} --create`,
	];
	writeErr(lines.join('\n'));
	return EXIT.finding;
}

/** The first few of `paths`, and how many more. */
function some(paths: readonly string[]) {
	const shown = paths.slice(0, 3).join(', ');
	return paths.length > 3 ? `${shown} and ${paths.length - 3} more` : shown;
}

/** One folder's sync, printed; its exit code. */
function printSync(path: string, done: FolderSync, json: boolean) {
	const name = basename(path);
	if (done.kind === 'git') {
		if (json) writeJson({ sync: { folder: path, git: true } });
		else
			writeErr(
				`${path} is kept by Git, so Epicenter does not sync it: Git syncs it.`,
			);
		return EXIT.finding;
	}
	if (done.kind === 'question') return printQuestion(done.question, json);
	const { report } = done;
	if (json)
		writeJson({
			sync: {
				folder: path,
				id: done.folder,
				made: done.made,
				joined: done.joined,
				...report,
			},
		});
	else if (report.outcome === 'deletions') {
		writeErr(
			`${path}: this sync would delete ${count(report.deletions.length, 'file')} on the server (${some(report.deletions)}), so it sent nothing.\nRun epicenter sync ${JSON.stringify(name)} --push-deletions to delete them there, or --restore-deletions to bring them back here.`,
		);
	} else {
		if (done.made)
			writeErr(`${path}: its folder on the server is ${done.folder}`);
		if (done.joined)
			writeErr(
				`${path}: synced with ${done.folder} for the first time; nothing was deleted on either side`,
			);
		const parts = [
			report.pulled.length > 0
				? `${count(report.pulled.length, 'file')} pulled`
				: '',
			report.pushed.length > 0
				? `${count(report.pushed.length, 'file')} pushed`
				: '',
			report.merged.length > 0
				? `${count(report.merged.length, 'note')} merged`
				: '',
		].filter(Boolean);
		writeOut(
			`${path}: ${report.outcome === 'synced' ? 'synced' : 'run sync again'}${parts.length > 0 ? ` (${parts.join(', ')})` : ', nothing changed'}`,
		);
		for (const path of report.conflicts)
			writeErr(
				`${path}: both sides changed the same lines; fix the conflict markers`,
			);
		for (const path of report.kept)
			writeErr(`${path}: changed while syncing; the next sync takes it`);
		for (const { path, reason } of report.refused)
			writeErr(`${path}: refused: ${reason}`);
	}
	return report.outcome === 'synced' && report.refused.length === 0
		? EXIT.ok
		: EXIT.finding;
}

/** What `--push-deletions` or `--restore-deletions` says, or why both were given. */
function deletionsOf(options: Options): Deletions | undefined | { refused: string } {
	if (options['push-deletions'] === true && options['restore-deletions'] === true)
		return { refused: 'Give --push-deletions or --restore-deletions, not both.' };
	if (options['push-deletions'] === true) return 'push';
	if (options['restore-deletions'] === true) return 'restore';
	return undefined;
}

/** What `--join <id>` or `--create` answers, or why both were given. */
function answerOf(options: Options): Answer | undefined | { refused: string } {
	if (typeof options.join === 'string' && options.create === true)
		return { refused: 'Give --join <id> or --create, not both.' };
	if (typeof options.join === 'string') return { join: options.join };
	if (options.create === true) return { create: true };
	return undefined;
}

/**
 * `epicenter sync [<folder>] [--join <id> | --create] [--push-deletions |
 * --restore-deletions]`: sync the folder (this directory by default) with
 * its folder on the server. `--all` syncs every folder in the Epicenter
 * folder that moved on either side.
 */
export async function syncCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const deletions = deletionsOf(options);
	if (typeof deletions === 'object') return fail(deletions.refused, json);
	const answer = answerOf(options);
	if (answer !== undefined && 'refused' in answer)
		return fail(answer.refused, json);
	const signedIn = await signedInNow(authContext());
	if (signedIn.error !== null) return fail(signedIn.error, json);
	const account = signedIn.data;
	const root = homeRoot();
	if (options.all === true) {
		if (dir !== undefined || answer !== undefined || deletions !== undefined)
			return fail(
				'--all syncs every folder; name none, and answer each one by name.',
				json,
			);
		const every = await syncEvery({ account, root, apps: firstPartyApps() });
		if (every.error !== null) return fail(every.error.message, json);
		if (every.data.warning !== null) writeErr(every.data.warning);
		let code: number = EXIT.ok;
		for (const { path, result, waiting } of every.data.folders) {
			if (waiting === 'local' || waiting === 'git') {
				if (json) writeJson({ sync: { folder: path, waiting } });
				continue;
			}
			if (result === undefined) {
				if (json) writeJson({ sync: { folder: path, unchanged: true } });
				continue;
			}
			const ran =
				result.error !== null
					? fail(`Could not sync ${path}: ${result.error.message}`, json)
					: printSync(path, result.data, json);
			code = Math.max(code, ran);
		}
		if (!json && every.data.folders.every(({ result }) => result === undefined))
			writeOut('Every folder is in sync.');
		return code;
	}
	const name = await folderNameIn(root, dir ?? '.');
	if (name.error !== null) return fail(name.error, json);
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
		return fail(`Could not sync ${path}: ${done.error.message}`, json);
	return printSync(path, done.data, json);
}

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
export async function cloneCommand(
	source: string | undefined,
	dir: string | undefined,
	json: boolean,
) {
	const account = signedInAccount(authContext());
	if (source === undefined) {
		const listing = await listFolders(account);
		if (listing.error !== null) return fail(listing.error.message, json);
		const { folders } = listing.data;
		if (json) writeJson({ folders });
		else
			writeOut(
				folders.length === 0
					? 'You hold no folders yet.'
					: folders
							.map(
								({ id, title, members }) =>
									`${id}  ${title ?? '(untitled)'}  ${describeMembers(members)}`,
							)
							.join('\n'),
			);
		return EXIT.ok;
	}
	const named = await folderOf(account, source);
	if (named.error !== null) return fail(named.error, json);
	const folder = named.data.id;
	const root = homeRoot();
	let name = named.data.title ?? folder;
	if (dir !== undefined) {
		if (dir.includes('/') && dirname(resolve(dir)) !== root.path)
			return fail(
				`${resolve(dir)} is not in ${root.path}: a folder is cloned into the Epicenter folder, by name.`,
				json,
			);
		name = basename(dir);
	}
	const cloned = await cloneIntoHome({ account, root, folder, name });
	if (cloned.error !== null) return fail(cloned.error.message, json);
	return printSync(cloned.data.local.path, cloned.data.sync, json);
}

/** The folder `dir` names, synced here, and its repository, or the message to fail with. */
async function syncedFolder(dir: string | undefined) {
	const root = homeRoot();
	const name = await folderNameIn(root, dir ?? '.');
	if (name.error !== null) return Err(name.error);
	const account = signedInAccount(authContext());
	const found = await identify({ root, account });
	if (found.error !== null) return Err(found.error.message);
	const bound = found.data.bound.find(({ local }) => local.name === name.data);
	const path = join(root.path, name.data);
	if (bound === undefined)
		return Err(
			`${path} is not synced on this computer: run epicenter sync on it first`,
		);
	const { local, record } = bound;
	return Ok({
		path,
		store: local.store,
		manifest: record,
		folder: record.folder,
		repository: folderRepository(account, record.folder),
	});
}

/** `epicenter log [<dir>] [--limit <n>]`: the folder's history on the server, newest first. */
export async function logCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const limit = options.limit === undefined ? 20 : Number(options.limit);
	if (!Number.isSafeInteger(limit) || limit < 1)
		return fail('--limit is a whole number above 0', json);
	const { data: at, error } = await syncedFolder(dir);
	if (error !== null) return fail(error, json);
	const log = await at.repository.log(limit);
	if (log.error !== null) return fail(log.error.message, json);
	if (json) writeJson({ log: log.data });
	else
		writeOut(
			log.data.length === 0
				? 'No history yet.'
				: log.data
						.map(
							({ id, time, message }) =>
								`${id.slice(0, 10)}  ${new Date(time * 1000).toISOString().slice(0, 16).replace('T', ' ')}  ${message.split('\n')[0]}${id === at.manifest.commit ? '  (this folder)' : ''}`,
						)
						.join('\n'),
		);
	return EXIT.ok;
}

type Change = { path: string; change: 'added' | 'changed' | 'deleted' };

const CHANGE_MARK = { added: 'A', changed: 'M', deleted: 'D' } as const;

function printChanges(changes: Change[], json: boolean, empty: string) {
	changes.sort((a, b) => (a.path < b.path ? -1 : 1));
	if (json) writeJson({ diff: changes });
	else
		writeOut(
			changes.length === 0
				? empty
				: changes
						.map(({ path, change }) => `${CHANGE_MARK[change]}  ${path}`)
						.join('\n'),
		);
}

/**
 * `epicenter diff [<dir>] [--since <commit>]`: the files this folder changed
 * since its last sync, or, with `--since`, the files the repository changed
 * between that commit and its head.
 */
export async function diffCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const { data: at, error } = await syncedFolder(dir);
	if (error !== null) return fail(error, json);
	if (typeof options.since !== 'string') {
		const listed = await at.store.list(['']);
		if (listed.error !== null) return fail(listed.error.message, json);
		const agreed = at.manifest.files;
		const here = new Map(
			listed.data
				.filter(({ path }) => !isHiddenPath(path))
				.map(({ path, version }) => [path, version]),
		);
		const changes: Change[] = [];
		for (const [path, version] of here)
			if (agreed[path] === undefined) changes.push({ path, change: 'added' });
			else if (agreed[path] !== version)
				changes.push({ path, change: 'changed' });
		for (const path of Object.keys(agreed))
			if (!here.has(path)) changes.push({ path, change: 'deleted' });
		printChanges(changes, json, 'Nothing changed since the last sync.');
		return EXIT.ok;
	}
	const since = await at.repository.changes(options.since);
	if (since.error !== null) return fail(since.error.message, json);
	const { commit: head, paths } = since.data;
	if (paths === null || head === null)
		return fail(`The repository holds no commit ${options.since}`, json);
	const [before, after] = await Promise.all([
		at.repository.tree(options.since, paths),
		at.repository.tree(head, paths),
	]);
	if (before.error !== null) return fail(before.error.message, json);
	if (after.error !== null) return fail(after.error.message, json);
	const was = new Set(before.data.map(({ path }) => path));
	const is = new Set(after.data.map(({ path }) => path));
	printChanges(
		paths
			.filter((path) => !isHiddenPath(path))
			.map((path) => ({
				path,
				change: !was.has(path)
					? 'added'
					: !is.has(path)
						? 'deleted'
						: 'changed',
			})),
		json,
		`Nothing changed since ${options.since}.`,
	);
	return EXIT.ok;
}

/**
 * `epicenter restore <commit> [<dir>] [--path <path>]`: make the folder's
 * files (or the one at `--path`) what they were at `<commit>`, here; the
 * next sync records it as a new change. A file made since is removed.
 */
export async function restoreCommand(
	commit: string,
	dir: string | undefined,
	options: Options,
	json: boolean,
) {
	const { data: at, error } = await syncedFolder(dir);
	if (error !== null) return fail(error, json);
	const only = typeof options.path === 'string' ? options.path : undefined;
	const then = await at.repository.tree(
		commit,
		only === undefined ? undefined : [only],
	);
	if (then.error !== null) return fail(then.error.message, json);
	const wanted = then.data.filter(({ path }) => !isHiddenPath(path));
	const listed = await at.store.list([only ?? '']);
	if (listed.error !== null) return fail(listed.error.message, json);
	const here = new Map(
		listed.data
			.filter(({ path }) => !isHiddenPath(path))
			.map(({ path, version }) => [path, version]),
	);
	const changed = wanted.filter(({ path, blob }) => here.get(path) !== blob);
	const bytes = await at.repository.blobs(changed);
	if (bytes.error !== null) return fail(bytes.error.message, json);
	const restored: string[] = [];
	for (const [index, { path }] of changed.entries()) {
		const content = bytes.data[index];
		if (content == null)
			return fail(`${path} could not be read at ${commit}`, json);
		const put = await at.store.put(path, content, here.get(path) ?? null);
		if (put.error !== null) return fail(`${path}: ${put.error.message}`, json);
		restored.push(path);
	}
	const kept = new Set(wanted.map(({ path }) => path));
	const removed: string[] = [];
	for (const [path, version] of here) {
		if (kept.has(path)) continue;
		const put = await at.store.put(path, null, version);
		if (put.error !== null) return fail(`${path}: ${put.error.message}`, json);
		removed.push(path);
	}
	if (json)
		writeJson({
			restored: { commit, folder: at.path, written: restored, removed },
		});
	else
		writeOut(
			restored.length + removed.length === 0
				? `${at.path} already holds ${commit}.`
				: `${at.path}: ${count(restored.length, 'file')} written and ${count(removed.length, 'file')} removed as at ${commit}; run epicenter sync to record it`,
		);
	return EXIT.ok;
}
