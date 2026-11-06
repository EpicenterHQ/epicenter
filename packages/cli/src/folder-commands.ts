/**
 * The Epicenter folder's commands (ADR-0811, ADR-0816, ADR-0817): `status`,
 * `init`, `share`, `unshare`, `accept`, `attach`, and `detach`, each a thin
 * wrapper over `@epicenter/folder/platform`, the functions the Epicenter
 * app composes too. Every command takes a folder by its path, or a folder on
 * the server by its id; a person by the email they sign in with.
 *
 * The credential is an access token for the deployment's Git audience, from
 * the CLI's sign-in (`epicenter auth login`).
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
	FOLDER_ROLES,
	type FolderRole,
	isFolderId,
	isPersonEmail,
	type ListedFolder,
} from '@epicenter/definition/site';
import { epicenterRoot, localFolder } from '@epicenter/folder/node';
import {
	acceptIntoHome,
	attachFolder,
	describeMembers,
	type EpicenterRoot,
	firstPartyApps,
	getFolder,
	type HomeFolder,
	identify,
	initFolder,
	listFolders,
	listHome,
	type RemoteAccount,
	shareFolder,
	unshareFolder,
} from '@epicenter/folder/platform';
import { Err, Ok, type Result } from 'wellcrafted/result';
import { resolveAppPaths } from './app-paths.ts';
import { authContext } from './auth.ts';
import { EXIT, fail, writeErr, writeJson, writeOut } from './output.ts';
import { signedInAccount } from './sync/account.ts';

type Options = Record<string, string | true>;

/** The Epicenter folder on this computer. */
export const homeRoot = () => epicenterRoot(resolveAppPaths().folderDir);

/**
 * The folder id `target` names: an id, or a folder in the Epicenter folder
 * (its path or name) that syncs on this computer. Fails with what to do
 * when it does not.
 */
export async function folderIdOf(
	target: string,
): Promise<Result<string, string>> {
	if (isFolderId(target)) return Ok(target);
	const root = homeRoot();
	const name = await folderNameIn(root, target);
	if (name.error !== null) return name;
	const found = await identify({ root });
	if (found.error !== null) return Err(found.error.message);
	const bound = found.data.bound.find(({ local }) => local.name === name.data);
	if (bound === undefined)
		return Err(
			`${name.data} is not synced on this computer: run epicenter sync on it first`,
		);
	return Ok(bound.record.folder);
}

/** `epicenter status`: the folders in the Epicenter folder, each one's state, and the shares waiting. */
export async function statusCommand(json: boolean) {
	const root = homeRoot();
	const apps = firstPartyApps();
	let account: RemoteAccount | undefined = signedInAccount(authContext());
	let home = await listHome({ root, account, apps });
	let offline: string | null = null;
	if (home.error !== null) {
		// Signed out, or the server out of reach: what this computer holds.
		offline = home.error.message;
		account = undefined;
		home = await listHome({ root, apps });
	}
	if (home.error !== null) return fail(home.error.message, json);
	if (json) {
		writeJson({ root: root.path, ...home.data, offline });
		return EXIT.ok;
	}
	const lines: string[] = [];
	if (home.data.folders.length === 0)
		lines.push(`No folders in ${root.path} yet.`);
	for (const folder of home.data.folders) lines.push(folderLine(folder));
	if (home.data.pending.length > 0) {
		lines.push('', 'Shared with you, waiting for epicenter accept:');
		for (const share of home.data.pending)
			lines.push(
				`  ${share.folder}  ${share.title ?? '(untitled)'}${share.from ? `, from ${share.from.name || share.from.email}` : ''}`,
			);
	}
	if (home.data.elsewhere.length > 0) {
		lines.push('', 'Yours, not on this computer (epicenter clone <id>):');
		for (const folder of home.data.elsewhere)
			lines.push(
				`  ${folder.id}  ${folder.title ?? '(untitled)'}  ${describeMembers(folder.members)}`,
			);
	}
	for (const { name, reason } of home.data.unreadable)
		lines.push(`${name}: ${reason}`);
	const check = home.data.fileSync;
	if (check !== null)
		lines.push('', 'refused' in check ? check.refused : check.warning);
	writeOut(lines.join('\n'));
	if (offline !== null)
		writeErr(`Members and shares are not shown: ${offline}`);
	return EXIT.ok;
}

function folderLine(folder: HomeFolder): string {
	const label =
		folder.title === null || folder.title === folder.name
			? folder.name
			: `${folder.name} (${folder.title})`;
	const state =
		folder.state === 'git'
			? 'kept by Git, so Epicenter does not sync it'
			: folder.state === 'local'
				? localState(folder)
				: folder.members === null
					? folder.state
					: `${folder.state}, ${describeMembers(folder.members)}`;
	return `${label}: ${state}${folder.unlisted ? ` (${folder.unlisted})` : ''}`;
}

/** A folder not synced here, and what it could be. */
function localState({ question, name }: HomeFolder): string {
	const sync = `epicenter sync ${JSON.stringify(name)}`;
	if (question === null || question.candidates.length === 0)
		return `on this computer only (${sync} makes it a folder on the server)`;
	if (question.silent !== null)
		return `on this computer only; it is your folder ${question.silent} (${sync} syncs it)`;
	const ids = question.candidates.map(({ folder }) => folder.id).join(', ');
	return `on this computer only; it could be ${ids} (${sync} asks which)`;
}

/**
 * `epicenter init [<path>] [--title <title>] [--dry-run]`: write the folder's
 * `epicenter.json`, proposing collections from the files in it.
 */
export async function initCommand(
	path: string | undefined,
	options: Options,
	json: boolean,
) {
	const local = await localFolder(path ?? '.');
	if (local.error !== null) return fail(local.error.message, json);
	const title =
		typeof options.title === 'string'
			? options.title
			: basename(local.data.path);
	const done = await initFolder({
		store: local.data.store,
		title,
		path: local.data.path,
		dryRun: options['dry-run'] === true,
	});
	if (done.error !== null) return fail(done.error.message, json);
	const { contract, left, written } = done.data;
	if (json) {
		writeJson({ init: { folder: local.data.path, written, contract, left } });
		return EXIT.ok;
	}
	writeOut(JSON.stringify(contract, null, 2));
	for (const { path, reason } of left) writeErr(`${path}: ${reason}`);
	writeErr(
		written
			? `${local.data.path}: wrote epicenter.json`
			: `${local.data.path}: nothing written (--dry-run)`,
	);
	return EXIT.ok;
}

/** The role `--role` names, `member` by default, or why it names none. */
function roleOf(options: Options): FolderRole | { refused: string } {
	const asked = options.role ?? 'member';
	return FOLDER_ROLES.includes(asked as FolderRole)
		? (asked as FolderRole)
		: { refused: `--role is ${FOLDER_ROLES.join(' or ')}, not '${asked}'.` };
}

function printFolder(folder: ListedFolder) {
	const lines = [
		`${folder.title ?? '(untitled)'}  ${folder.id}`,
		...folder.members.map(
			({ email, name, role, you }) =>
				`  ${role.padEnd(6)}  ${name ? `${name} <${email}>` : email}${you ? ' (you)' : ''}`,
		),
		...folder.invited.map(
			({ email, role }) => `  ${role.padEnd(6)}  ${email} (invited)`,
		),
	];
	writeOut(lines.join('\n'));
}

/**
 * `epicenter share <folder> [<email>] [--role member|reader]`: invite an
 * email to the folder, or change the role of someone who holds it; without
 * an email, who holds it and who is invited.
 */
export async function shareCommand(
	target: string,
	person: string | undefined,
	options: Options,
	json: boolean,
) {
	const folder = await folderIdOf(target);
	if (folder.error !== null) return fail(folder.error, json);
	const account = signedInAccount(authContext());
	if (person === undefined) {
		const listed = await getFolder(account, folder.data);
		if (listed.error !== null) return fail(listed.error.message, json);
		if (json) writeJson(listed.data);
		else printFolder(listed.data);
		return EXIT.ok;
	}
	if (!isPersonEmail(person))
		return fail(
			`Name a person by the email they sign in with, not '${person}'.`,
			json,
		);
	const role = roleOf(options);
	if (typeof role !== 'string') return fail(role.refused, json);
	const shared = await shareFolder(account, {
		folder: folder.data,
		email: person,
		role,
	});
	if (shared.error !== null) return fail(shared.error.message, json);
	if (json) writeJson({ share: { folder: folder.data, ...shared.data } });
	else
		writeOut(
			shared.data.pending
				? `Invited ${person} as a ${role}: the folder is theirs once whoever signs in with that email accepts it.`
				: `${person} is now a ${role}.`,
		);
	return EXIT.ok;
}

/**
 * `epicenter unshare <folder> <email>`: take a person out of a folder, or
 * cancel their invitation; with your own email, leave it, or decline one.
 */
export async function unshareCommand(
	target: string,
	person: string,
	json: boolean,
) {
	const folder = await folderIdOf(target);
	if (folder.error !== null) return fail(folder.error, json);
	if (!isPersonEmail(person))
		return fail(
			`Name a person by the email they sign in with, not '${person}'.`,
			json,
		);
	const removed = await unshareFolder(signedInAccount(authContext()), {
		folder: folder.data,
		email: person,
	});
	if (removed.error !== null) return fail(removed.error.message, json);
	if (json) writeJson({ unshare: { folder: folder.data, ...removed.data } });
	else
		writeOut(
			removed.data.folderGone
				? `${person} left, the last to hold it: the folder is gone from the server. Its files here stay.`
				: `${person} no longer holds the folder or is invited to it; any files they have stay with them.`,
		);
	return EXIT.ok;
}

/**
 * `epicenter accept [<folder>]`: accept a share and bring the folder into
 * the Epicenter folder beside your own; without one, the shares waiting.
 */
export async function acceptCommand(target: string | undefined, json: boolean) {
	const account = signedInAccount(authContext());
	const listing = await listFolders(account);
	if (listing.error !== null) return fail(listing.error.message, json);
	const { pending } = listing.data;
	if (target === undefined) {
		if (json) writeJson({ pending });
		else
			writeOut(
				pending.length === 0
					? 'No shares are waiting for you.'
					: pending
							.map(
								(share) =>
									`${share.folder}  ${share.title ?? '(untitled)'}  as ${share.role}${share.from ? `, from ${share.from.name || share.from.email}` : ''}`,
							)
							.join('\n'),
			);
		return EXIT.ok;
	}
	const share = pending.find(
		(one) => one.folder === target || one.title === target,
	);
	if (share === undefined)
		return fail(`No share of '${target}' is waiting for you.`, json);
	const accepted = await acceptIntoHome({
		account,
		root: homeRoot(),
		folder: share.folder,
	});
	if (accepted.error !== null) return fail(accepted.error.message, json);
	const { local, sync } = accepted.data;
	if (json)
		writeJson({ accept: { folder: share.folder, path: local.path, sync } });
	else writeOut(`${share.title ?? share.folder} is in ${local.path}.`);
	return sync.kind === 'synced' && sync.report.outcome === 'synced'
		? EXIT.ok
		: EXIT.finding;
}

/**
 * `epicenter attach <folder> <app>` and `detach`: let an app reach the
 * folder, or stop it ("Use this folder with", ADR-0811). `<app>` is the
 * client id it signs in as, such as `so.epicenter.todos`.
 */
export async function attachCommand(
	target: string,
	app: string,
	attached: boolean,
	json: boolean,
) {
	const folder = await folderIdOf(target);
	if (folder.error !== null) return fail(folder.error, json);
	const done = await attachFolder(signedInAccount(authContext()), {
		folder: folder.data,
		app,
		attached,
	});
	if (done.error !== null) return fail(done.error.message, json);
	if (json)
		writeJson({
			[attached ? 'attach' : 'detach']: { folder: folder.data, ...done.data },
		});
	else
		writeOut(
			attached
				? `${app} reaches the folder ${folder.data}.`
				: `${app} no longer reaches the folder ${folder.data}.`,
		);
	return EXIT.ok;
}
/**
 * The name, in the Epicenter folder `root`, of the folder `target` names:
 * its path, or its name there. A directory anywhere else is refused: a
 * folder syncs only inside the Epicenter folder, and one elsewhere joins by
 * a link there (ADR-0821).
 */
export async function folderNameIn(
	root: EpicenterRoot,
	target: string,
): Promise<Result<string, string>> {
	const real = (path: string) => realpath(path).catch(() => resolve(path));
	const absolute = resolve(target);
	const parent = dirname(absolute);
	if (
		parent === root.path ||
		(await real(parent)) === (await real(root.path))
	)
		return Ok(basename(absolute));
	// A bare name names the folder in the Epicenter folder, wherever this runs.
	const bare = !target.includes('/') && target !== '.' && target !== '..';
	if (bare && (await realpath(join(root.path, target)).catch(() => null)))
		return Ok(target);
	return Err(
		`${absolute} is not a folder in ${root.path}: Epicenter syncs the folders in it. Move the folder there, or link it there.`,
	);
}
