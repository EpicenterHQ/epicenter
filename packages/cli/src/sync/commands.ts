/**
 * `epicenter sync`, `clone`, `log`, `diff`, and `restore` (ADR-0804,
 * ADR-0811): a plain folder on this computer synced with its folder on the
 * server by the functions every surface composes, `syncFolder` and its
 * kin from `@epicenter/folder/platform`. The local side is the directory's
 * store, the remote the folder's repository reached by its id, and the
 * manifest `.epicenter/synced.json`, which names that id and the directory
 * it synced in. No Git runs on this computer: history is the server's, read
 * here by `log` and `diff` and brought back by `restore`, and a person who
 * wants Git clones the folder's remote with Git.
 *
 * A folder's first sync joins the folder its manifest names when the person
 * holds it, and otherwise makes one; a copied folder (its manifest names
 * another directory) sends nothing until `--new` or `--same` answers what
 * it is. `clone` brings a folder the person holds into the Epicenter folder.
 * Exit codes: 0 synced, 1 a sync to run again, a file the repository
 * refused, or a copy's question, 2 what the command cannot use (no sign-in,
 * no such folder, the server out of reach).
 */
import { isHiddenPath } from '@epicenter/definition/contract';
import { localFolder } from '@epicenter/folder/node';
import {
	type CopyAnswer,
	cloneFolder,
	cloneIntoHome,
	describeMembers,
	type FolderSync,
	listFolders,
	type RemoteAccount,
	syncEvery,
	syncFolder,
} from '@epicenter/folder/platform';
import { folderRepository, storeManifest } from '@epicenter/folder/sync';
import { Err, Ok } from 'wellcrafted/result';
import { authContext, type GrantKind } from '../auth.ts';
import { homeRoot } from '../folder-commands.ts';
import { count, EXIT, fail, writeErr, writeJson, writeOut } from '../output.ts';
import { signedInAccount } from './account.ts';

type Options = Record<string, string | true>;

/** One folder's sync, printed; its exit code. */
function printSync(path: string, done: FolderSync, json: boolean) {
	if (done.kind === 'copy') {
		const message = `${path} is a copy of the folder ${done.copyOf}, made in another directory, so it sent nothing. Run epicenter sync --new to make it a folder of its own, or --same if it is that folder, moved.`;
		if (json) writeJson({ sync: { folder: path, copyOf: done.copyOf } });
		else writeErr(message);
		return EXIT.finding;
	}
	if (done.kind === 'choose') {
		if (json) writeJson({ sync: { folder: path, choose: done.folders } });
		else
			writeErr(
				`${path}: you hold several folders this app uses (${done.folders.join(', ')}); clone one into it.`,
			);
		return EXIT.finding;
	}
	const { report } = done;
	if (json)
		writeJson({
			sync: { folder: path, id: done.folder, made: done.made, ...report },
		});
	else {
		if (done.made)
			writeErr(`${path}: its folder on the server is ${done.folder}`);
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

/** The answer `--new` or `--same` gives a copy, or why both were given. */
function copyAnswer(options: Options): CopyAnswer | undefined | string {
	if (options.new === true && options.same === true)
		return 'Give --new or --same, not both.';
	return options.new === true
		? 'new'
		: options.same === true
			? 'same'
			: undefined;
}

/**
 * `epicenter sync [<dir>] [--new | --same]`: sync the folder (this
 * directory by default) with its folder on the server. `--all` syncs every
 * folder in the Epicenter folder that moved on either side.
 */
export async function syncCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const account = signedInAccount(authContext(), grant);
	if (options.all === true) {
		if (dir !== undefined)
			return fail('--all syncs every folder; name none.', json);
		const every = await syncEvery({ account, root: homeRoot() });
		if (every.error !== null) return fail(every.error.message, json);
		let code: number = EXIT.ok;
		for (const { path, result, waiting } of every.data) {
			if (waiting) {
				if (json) writeJson({ sync: { folder: path, neverSynced: true } });
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
		if (!json && every.data.every(({ result }) => result === undefined))
			writeOut('Every folder is in sync.');
		return code;
	}
	const answer = copyAnswer(options);
	if (typeof answer === 'string' && answer !== 'new' && answer !== 'same')
		return fail(answer, json);
	const local = await localFolder(dir ?? '.');
	if (local.error !== null) return fail(local.error.message, json);
	const done = await syncFolder({
		account,
		store: local.data.store,
		identity: local.data.identity,
		copy: answer as CopyAnswer | undefined,
	});
	if (done.error !== null)
		return fail(
			`Could not sync ${local.data.path}: ${done.error.message}`,
			json,
		);
	return printSync(local.data.path, done.data, json);
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
 * `epicenter clone [<folder>] [<dir>]`: without a folder, the folders the
 * person holds by title and who holds them; with one (its id or title),
 * bring it into `<dir>`, or a new folder in the Epicenter folder named for
 * its title, and sync, which takes its files. A folder that already holds
 * files keeps them, merged on top.
 */
export async function cloneCommand(
	source: string | undefined,
	dir: string | undefined,
	json: boolean,
	grant: GrantKind,
) {
	const account = signedInAccount(authContext(), grant);
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
	if (dir === undefined) {
		const cloned = await cloneIntoHome({
			account,
			root: homeRoot(),
			folder,
			name: named.data.title ?? folder,
		});
		if (cloned.error !== null) return fail(cloned.error.message, json);
		return printSync(cloned.data.local.path, cloned.data.sync, json);
	}
	const local = await localFolder(dir, { make: true });
	if (local.error !== null) return fail(local.error.message, json);
	const cloned = await cloneFolder({ account, folder, local: local.data });
	if (cloned.error !== null) return fail(cloned.error.message, json);
	return printSync(local.data.path, cloned.data, json);
}

/** The folder at `dir` and its repository, or the message to fail with. */
async function syncedFolder(dir: string | undefined, grant: GrantKind) {
	const local = await localFolder(dir ?? '.');
	if (local.error !== null) return Err(local.error.message);
	const { path, store } = local.data;
	const read = await storeManifest(store).read();
	if (read.error !== null)
		return Err(`Could not read .epicenter/synced.json: ${read.error.message}`);
	const { manifest } = read.data;
	const { folder } = manifest;
	if (folder === undefined)
		return Err(
			`${path} has never synced: run epicenter sync, or epicenter clone <folder> into it`,
		);
	const repository = folderRepository(
		signedInAccount(authContext(), grant),
		folder,
	);
	return Ok({ path, store, manifest, folder, repository });
}

/** `epicenter log [<dir>] [--limit <n>]`: the folder's history on the server, newest first. */
export async function logCommand(
	dir: string | undefined,
	options: Options,
	json: boolean,
	grant: GrantKind,
) {
	const limit = options.limit === undefined ? 20 : Number(options.limit);
	if (!Number.isSafeInteger(limit) || limit < 1)
		return fail('--limit is a whole number above 0', json);
	const { data: at, error } = await syncedFolder(dir, grant);
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
	grant: GrantKind,
) {
	const { data: at, error } = await syncedFolder(dir, grant);
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
	grant: GrantKind,
) {
	const { data: at, error } = await syncedFolder(dir, grant);
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
