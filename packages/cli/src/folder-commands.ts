/**
 * The Epicenter folder's operations (ADR-0811, ADR-0816, ADR-0817):
 * `status`, `init`, `share`, `unshare`, `accept`, `attach`, and `detach`,
 * each a thin wrapper over `@epicenter/folder/platform`, the functions the
 * Epicenter app composes too. Every one takes a folder by its path, or a
 * folder on the server by its id; a person by the email they sign in with.
 *
 * The credential is an access token for the deployment's Git audience, from
 * the CLI's sign-in (`epicenter auth login`).
 */
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import {
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
import type { ImplementationOf } from './operation.ts';
import type {
	accept as acceptOperation,
	attach as attachOperation,
	detach as detachOperation,
	init as initOperation,
	share as shareOperation,
	status as statusOperation,
	unshare as unshareOperation,
} from './operations.ts';
import { writeErr, writeOut } from './output.ts';
import { signedInAccount } from './sync/account.ts';

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
export const status: ImplementationOf<typeof statusOperation> = {
	async run() {
		const root = homeRoot();
		const apps = firstPartyApps();
		const account: RemoteAccount = signedInAccount(authContext());
		let home = await listHome({ root, account, apps });
		let offline: string | null = null;
		if (home.error !== null) {
			// Signed out, or the server out of reach: what this computer holds.
			offline = home.error.message;
			home = await listHome({ root, apps });
		}
		if (home.error !== null) return Err(home.error.message);
		return Ok({ output: { root: root.path, ...home.data, offline } });
	},
	print(output) {
		const lines: string[] = [];
		if (output.folders.length === 0)
			lines.push(`No folders in ${output.root} yet.`);
		for (const folder of output.folders)
			lines.push(folderLine(folder as HomeFolder));
		if (output.pending.length > 0) {
			lines.push('', 'Shared with you, waiting for epicenter accept:');
			for (const share of output.pending)
				lines.push(
					`  ${share.folder}  ${share.title ?? '(untitled)'}${share.from ? `, from ${share.from.name || share.from.email}` : ''}`,
				);
		}
		if (output.elsewhere.length > 0) {
			lines.push('', 'Yours, not on this computer (epicenter clone <id>):');
			for (const folder of output.elsewhere)
				lines.push(
					`  ${folder.id}  ${folder.title ?? '(untitled)'}  ${describeMembers(folder.members as ListedFolder['members'])}`,
				);
		}
		for (const { name, reason } of output.unreadable)
			lines.push(`${name}: ${reason}`);
		const check = output.fileSync as
			| { refused: string }
			| { warning: string }
			| null;
		if (check !== null)
			lines.push('', 'refused' in check ? check.refused : check.warning);
		if (output.git !== null) lines.push('', output.git);
		writeOut(lines.join('\n'));
		if (output.offline !== null)
			writeErr(`Members and shares are not shown: ${output.offline}`);
	},
};

function folderLine(folder: HomeFolder): string {
	const label =
		folder.title === null || folder.title === folder.name
			? folder.name
			: `${folder.name} (${folder.title})`;
	const state =
		folder.state === 'git'
			? 'kept by Git, so Epicenter does not sync it'
			: folder.state === 'outside'
				? 'a link to a folder outside the Epicenter folder, so Epicenter does not sync it (move the folder in, and leave a link where it was)'
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
export const init: ImplementationOf<typeof initOperation> = {
	async run({ path = '.', title, dryRun = false }) {
		const local = await localFolder(path);
		if (local.error !== null) return Err(local.error.message);
		const done = await initFolder({
			store: local.data.store,
			title: title ?? basename(local.data.path),
			path: local.data.path,
			dryRun,
		});
		if (done.error !== null) return Err(done.error.message);
		const { contract, left, written } = done.data;
		return Ok({
			output: { init: { folder: local.data.path, written, contract, left } },
		});
	},
	print({ init: { folder, written, contract, left } }) {
		writeOut(JSON.stringify(contract, null, 2));
		for (const { path, reason } of left) writeErr(`${path}: ${reason}`);
		writeErr(
			written
				? `${folder}: wrote epicenter.json`
				: `${folder}: nothing written (--dry-run)`,
		);
	},
};

function folderText(folder: ListedFolder) {
	return [
		`${folder.title ?? '(untitled)'}  ${folder.id}`,
		...folder.members.map(
			({ email, name, role, you }) =>
				`  ${role.padEnd(6)}  ${name ? `${name} <${email}>` : email}${you ? ' (you)' : ''}`,
		),
		...folder.invited.map(
			({ email, role }) => `  ${role.padEnd(6)}  ${email} (invited)`,
		),
	].join('\n');
}

/** Why `person` names no one: they are named by the email they sign in with. */
const notAnEmail = (person: string) =>
	Err(`Name a person by the email they sign in with, not '${person}'.`);

/**
 * `epicenter share <folder> [<email>] [--role member|reader]`: invite an
 * email to the folder, or change the role of someone who holds it; without
 * an email, who holds it and who is invited.
 */
export const share: ImplementationOf<typeof shareOperation> = {
	async run({ folder: target, email, role = 'member' }) {
		const folder = await folderIdOf(target);
		if (folder.error !== null) return folder;
		const account = signedInAccount(authContext());
		if (email === undefined) {
			const listed = await getFolder(account, folder.data);
			if (listed.error !== null) return Err(listed.error.message);
			return Ok({ output: { folder: listed.data } });
		}
		if (!isPersonEmail(email)) return notAnEmail(email);
		const shared = await shareFolder(account, {
			folder: folder.data,
			email,
			role,
		});
		if (shared.error !== null) return Err(shared.error.message);
		return Ok({ output: { share: { folder: folder.data, ...shared.data } } });
	},
	print(output) {
		if (output.folder !== undefined)
			writeOut(folderText(output.folder as ListedFolder));
		else if (output.share !== undefined) {
			const { person, role, pending } = output.share;
			writeOut(
				pending
					? `Invited ${person} as a ${role}: the folder is theirs once whoever signs in with that email accepts it.`
					: `${person} is now a ${role}.`,
			);
		}
	},
};

/**
 * `epicenter unshare <folder> <email>`: take a person out of a folder, or
 * cancel their invitation; with your own email, leave it, or decline one.
 */
export const unshare: ImplementationOf<typeof unshareOperation> = {
	async run({ folder: target, email }) {
		const folder = await folderIdOf(target);
		if (folder.error !== null) return folder;
		if (!isPersonEmail(email)) return notAnEmail(email);
		const removed = await unshareFolder(signedInAccount(authContext()), {
			folder: folder.data,
			email,
		});
		if (removed.error !== null) return Err(removed.error.message);
		return Ok({
			output: { unshare: { folder: folder.data, ...removed.data } },
		});
	},
	print({ unshare: { person, folderGone } }) {
		writeOut(
			folderGone
				? `${person} left, the last to hold it: the folder is gone from the server. Its files here stay.`
				: `${person} no longer holds the folder or is invited to it; any files they have stay with them.`,
		);
	},
};

/**
 * `epicenter accept [<folder>]`: accept a share and bring the folder into
 * the Epicenter folder beside your own; without one, the shares waiting.
 */
export const accept: ImplementationOf<typeof acceptOperation> = {
	async run({ folder: target }) {
		const account = signedInAccount(authContext());
		const listing = await listFolders(account);
		if (listing.error !== null) return Err(listing.error.message);
		const { pending } = listing.data;
		if (target === undefined) return Ok({ output: { pending } });
		const share = pending.find(
			(one) => one.folder === target || one.title === target,
		);
		if (share === undefined)
			return Err(`No share of '${target}' is waiting for you.`);
		const accepted = await acceptIntoHome({
			account,
			root: homeRoot(),
			folder: share.folder,
		});
		if (accepted.error !== null) return Err(accepted.error.message);
		const { local, sync } = accepted.data;
		return Ok({
			output: { accept: { folder: share.folder, path: local.path, sync } },
			finding: !(sync.kind === 'synced' && sync.report.outcome === 'synced'),
		});
	},
	print(output) {
		if (output.accept !== undefined) {
			writeOut(`${output.accept.folder} is in ${output.accept.path}.`);
			return;
		}
		const pending = output.pending ?? [];
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
	},
};

/**
 * `epicenter attach <folder> <app>` and `detach`: let an app reach the
 * folder, or stop it ("Use this folder with", ADR-0811). `<app>` is the
 * client id it signs in as, such as `so.epicenter.todos`.
 */
async function attachRun(target: string, app: string, attached: boolean) {
	const folder = await folderIdOf(target);
	if (folder.error !== null) return folder;
	const done = await attachFolder(signedInAccount(authContext()), {
		folder: folder.data,
		app,
		attached,
	});
	if (done.error !== null) return Err(done.error.message);
	return Ok({ ...done.data, folder: folder.data, app });
}

export const attach: ImplementationOf<typeof attachOperation> = {
	async run({ folder, app }) {
		const done = await attachRun(folder, app, true);
		if (done.error !== null) return done;
		return Ok({ output: { attach: done.data } });
	},
	print({ attach: { folder, app } }) {
		writeOut(`${app} reaches the folder ${folder}.`);
	},
};

export const detach: ImplementationOf<typeof detachOperation> = {
	async run({ folder, app }) {
		const done = await attachRun(folder, app, false);
		if (done.error !== null) return done;
		return Ok({ output: { detach: done.data } });
	},
	print({ detach: { folder, app } }) {
		writeOut(`${app} no longer reaches the folder ${folder}.`);
	},
};

/**
 * The name, in the Epicenter folder `root`, of the folder `target` names:
 * its path, or its name there. A directory anywhere else is refused: a
 * folder syncs only as a real directory in the Epicenter folder (ADR-0825).
 */
export async function folderNameIn(
	root: EpicenterRoot,
	target: string,
): Promise<Result<string, string>> {
	const real = (path: string) => realpath(path).catch(() => resolve(path));
	const absolute = resolve(target);
	const parent = dirname(absolute);
	if (parent === root.path || (await real(parent)) === (await real(root.path)))
		return Ok(basename(absolute));
	// A bare name names the folder in the Epicenter folder, wherever this runs.
	const bare = !target.includes('/') && target !== '.' && target !== '..';
	if (bare && (await realpath(join(root.path, target)).catch(() => null)))
		return Ok(target);
	return Err(
		`${absolute} is not a folder in ${root.path}: Epicenter syncs the folders in it. Move the folder there, and leave a link where it was.`,
	);
}
