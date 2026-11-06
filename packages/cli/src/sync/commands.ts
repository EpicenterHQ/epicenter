/**
 * `epicenter sync`, `clone`, `log`, `diff`, and `restore` (ADR-0804): a
 * plain folder on this computer synced with its repository on the server by
 * the one TypeScript function every surface runs,
 * `sync({ local, remote, manifest })` from `@epicenter/folder/sync`. The
 * local side is the directory's store, the remote the folder's repository
 * reached by its id, and the manifest `.epicenter/synced.json`, which names
 * that id. No Git runs on this computer: history is the server's, read here
 * by `log` and `diff` and brought back by `restore`, and a person who wants
 * Git clones the repository with Git.
 *
 * A folder's first sync mints its repository and records its id; `clone`
 * records the id of a repository that exists, so the next sync takes its
 * files (and merges any already in the folder). Exit codes: 0 synced, 1 a
 * sync to run again or a file the repository refused, 2 what the command
 * cannot use (no sign-in, no such folder, the server out of reach).
 */
import { mkdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isHiddenPath } from '@epicenter/definition/contract';
import {
	isFolderId,
	isRepositoryName,
	parseRepositoryPath,
	type RepositoryListing,
} from '@epicenter/definition/site';
import { nodeStore } from '@epicenter/folder/node';
import {
	folderRepository,
	type Manifest,
	type ManifestStore,
	type ManifestVersion,
	mintFolder,
	type RemoteAccount,
	type SyncReport,
	storeManifest,
	sync,
} from '@epicenter/folder/sync';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { authContext, type GrantKind } from '../auth.ts';
import { count, EXIT, fail, writeErr, writeJson, writeOut } from '../output.ts';
import { signedInAccount } from './account.ts';

type Options = Record<string, string | true>;

/** A directory's store, as `@epicenter/folder/node` opens one. */
type Store = ReturnType<typeof nodeStore>;

/**
 * The folder at `dir` (made when `make`): its path, its store, where its
 * manifest is kept (`saved`), and the manifest it holds; or the message to
 * fail with.
 */
async function folderAt(
	dir: string,
	{ make = false } = {},
): Promise<
	Result<
		{
			path: string;
			store: Store;
			saved: ManifestStore;
			manifest: Manifest;
			version: ManifestVersion;
		},
		string
	>
> {
	const path = resolve(dir);
	if (make) await mkdir(path, { recursive: true });
	const found = await stat(path).catch(() => undefined);
	if (found === undefined) return Err(`${path} does not exist`);
	if (!found.isDirectory()) return Err(`${path} is not a folder`);
	const store = nodeStore(path);
	const saved = storeManifest(store);
	const read = await saved.read();
	if (read.error !== null)
		return Err(`Could not read .epicenter/synced.json: ${read.error.message}`);
	return Ok({ path, store, saved, ...read.data });
}

/** Write `next` as the folder's first manifest, over `version`. */
async function startManifest(
	manifest: ManifestStore,
	next: Manifest,
	version: ManifestVersion,
) {
	const written = await manifest.write(next, version);
	if (written.error !== null) return written.error.message;
	if (written.data === 'moved')
		return 'Another sync of this folder started meanwhile; run it again.';
	return null;
}

/** One sync of the folder at `path` with its repository, printed. */
async function runSync({
	account,
	path,
	folder,
	store,
	saved,
	json,
}: {
	account: RemoteAccount;
	path: string;
	folder: string;
	store: Store;
	saved: ManifestStore;
	json: boolean;
}) {
	const ran = await sync({
		local: store,
		remote: folderRepository(account, folder),
		manifest: saved,
	});
	if (ran.error !== null)
		return fail(`Could not sync ${path}: ${ran.error.message}`, json);
	const report: SyncReport = ran.data;
	if (json) writeJson({ sync: { folder: path, id: folder, ...report } });
	else {
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

/**
 * `epicenter sync [<dir>]`: sync the folder (this directory by default)
 * with its repository, minting one at its first sync.
 */
export async function syncCommand(
	dir: string | undefined,
	json: boolean,
	grant: GrantKind,
) {
	const { data: at, error } = await folderAt(dir ?? '.');
	if (error !== null) return fail(error, json);
	const account = signedInAccount(authContext(), grant);
	let folder = at.manifest.folder;
	if (folder === undefined) {
		const minted = await mintFolder(account);
		if (minted.error !== null)
			return fail(
				`Could not make this folder's repository: ${minted.error.message}`,
				json,
			);
		folder = minted.data.folder;
		const problem = await startManifest(
			at.saved,
			{ ...at.manifest, folder },
			at.version,
		);
		if (problem !== null) return fail(problem, json);
		if (!json) writeErr(`${at.path}: its repository is ${folder}`);
	}
	return runSync({ ...at, account, folder, json });
}

/**
 * The folder id `source` names: an id, or `<namespace>/<name>` (`~` for the
 * caller's own) among the repositories the sign-in may reach.
 */
async function folderOf(
	account: RemoteAccount,
	source: string,
): Promise<{ folder: string; name: string } | { error: string }> {
	if (isFolderId(source)) return { folder: source, name: source };
	const own = /^~\/(.+)$/.exec(source)?.[1];
	const named =
		own !== undefined && isRepositoryName(own)
			? { namespace: null, name: own }
			: parseRepositoryPath(source);
	if (named === undefined)
		return {
			error: `'${source}' is neither a folder id nor <namespace>/<name>`,
		};
	let listing: RepositoryListing;
	try {
		const response = await account.fetch(`${account.baseURL}/api/repos`);
		if (!response.ok)
			return { error: `${account.baseURL} answered ${response.status}` };
		listing = (await response.json()) as RepositoryListing;
	} catch (cause) {
		return { error: cause instanceof Error ? cause.message : String(cause) };
	}
	const namespace = listing.namespaces.find((space) =>
		named.namespace === null ? space.personal : space.id === named.namespace,
	);
	const found = namespace?.repositories.find(({ name }) => name === named.name);
	if (found === undefined) return { error: `No repository is named ${source}` };
	return { folder: found.id, name: found.name };
}

/**
 * `epicenter clone <folder> [<dir>]`: record the repository `<folder>`
 * names in `<dir>` (by default a new directory named for it here), and
 * sync, which brings its files; a folder that already holds files merges
 * them on top.
 */
export async function cloneCommand(
	source: string,
	dir: string | undefined,
	json: boolean,
	grant: GrantKind,
) {
	const account = signedInAccount(authContext(), grant);
	const named = await folderOf(account, source);
	if ('error' in named) return fail(named.error, json);
	const { data: at, error } = await folderAt(dir ?? named.name, { make: true });
	if (error !== null) return fail(error, json);
	if (at.manifest.folder !== undefined && at.manifest.folder !== named.folder)
		return fail(
			`${at.path} already syncs with ${at.manifest.folder}; clone into another folder`,
			json,
		);
	if (at.manifest.folder === undefined) {
		const problem = await startManifest(
			at.saved,
			{ folder: named.folder, commit: null, files: {} },
			at.version,
		);
		if (problem !== null) return fail(problem, json);
	}
	return runSync({ ...at, account, folder: named.folder, json });
}

/** The folder at `dir` and its repository, or the message to fail with. */
async function syncedFolder(dir: string | undefined, grant: GrantKind) {
	const { data: at, error } = await folderAt(dir ?? '.');
	if (error !== null) return Err(error);
	const { folder } = at.manifest;
	if (folder === undefined)
		return Err(
			`${at.path} has never synced: run epicenter sync, or epicenter clone <folder> into it`,
		);
	const repository = folderRepository(
		signedInAccount(authContext(), grant),
		folder,
	);
	return Ok({ ...at, folder, repository });
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
