/**
 * The Git receiver: every push to a hosted repository lands here, never in
 * the store's own receive-pack (spike 6's receiver, decisions 33, 38, 40, 51).
 *
 * - Only `refs/heads/main` may be pushed, and never deleted. The client's
 *   old value must be `main` now, so a push that raced a web write is told
 *   to fetch first.
 * - Fast-forward is decided from the pushed commits alone (decision 51):
 *   the client leaves out only what the advertised `main` already reaches,
 *   so a push that extends `main` carries a path of commits from its tip to
 *   `main`. Merge commits are ordinary. No server history is walked.
 * - A push that is not a fast-forward is accepted only from the repository
 *   owner, and saves the `main` it replaces as
 *   `refs/epicenter/replaced/<time>` in the same transaction (decision 33).
 * - Every file other than a `.md` note or a hidden path (decision 58) must
 *   be a Git LFS pointer whose object is stored and verified, whatever
 *   `.gitattributes` says (decisions 38 and 40, codex-2's amendment). The
 *   rule covers every commit `next` reaches that `main` does not
 *   (`rev-list next --not main`), read from the pack or the store, so a
 *   commit an earlier pack carried but nothing checked cannot be merged in
 *   later. Only entries a commit changes against its first parent are
 *   checked. Symlinks and submodules are refused.
 *
 * The advertisement shows `main` alone, offers `ofs-delta`, and asks for
 * no thin packs, so the pack can be read without the server's objects.
 * Refusals use stock Git's report, which prints them as
 * `! [remote rejected] main -> main (<reason>)`.
 */

import { storedWithLfs } from '@epicenter/definition/contract';
import { MAX_POINTER_BYTES, readPointer } from '../git/lfs-rule.js';
import {
	type GitObjects,
	MAIN,
	type ObjectKind,
	type PackObject,
	parseCommit,
	parseTree,
	TREE_MODE,
	type TreeEntry,
	ZERO_OID,
} from '../git/objects.js';
import { readPack } from '../git/pack.js';
import { FLUSH, pktLine, readCommandLines } from '../git/pkt.js';
import { LFS_OID, type LfsStore } from '../lfs/lfs-store.js';

const CAPABILITIES =
	'report-status side-band-64k ofs-delta no-thin agent=epicenter';
/** The largest push body read; Artifacts caps a push at 64 MiB too. */
export const MAX_PUSH_BYTES = 64 * 1024 * 1024;
const resultHeaders = {
	'content-type': 'application/x-git-receive-pack-result',
	'cache-control': 'no-cache',
};

/** `main` alone, with this receiver's capabilities. */
export async function receiveAdvertisement(
	objects: GitObjects | null,
): Promise<Response> {
	const main = objects ? (await objects.refs()).get(MAIN) : undefined;
	const first = main
		? `${main} ${MAIN}\0${CAPABILITIES}\n`
		: `${ZERO_OID} capabilities^{}\0${CAPABILITIES}\n`;
	return new Response(
		Buffer.concat([
			pktLine('# service=git-receive-pack\n'),
			FLUSH,
			pktLine(first),
			FLUSH,
		]),
		{
			headers: {
				'content-type': 'application/x-git-receive-pack-advertisement',
				'cache-control': 'no-cache',
			},
		},
	);
}

/**
 * The report-status for `ref`; inside side-band channel 1 when the client
 * asked for `side-band-64k` (isomorphic-git always does).
 */
function report(ref: string, outcome: string, sideBand: boolean): Response {
	const status = Buffer.concat([
		pktLine('unpack ok\n'),
		pktLine(outcome === 'ok' ? `ok ${ref}\n` : `ng ${ref} ${outcome}\n`),
		FLUSH,
	]);
	return new Response(
		sideBand
			? Buffer.concat([pktLine(Buffer.concat([Buffer.of(1), status])), FLUSH])
			: status,
		{ headers: resultHeaders },
	);
}

/** Reads an object from the pushed pack first, then from the store. */
function objectSource(objects: GitObjects, pushed: Map<string, PackObject>) {
	return async (oid: string, kind: ObjectKind, maxBytes?: number) => {
		const inPack = pushed.get(oid);
		if (inPack)
			return inPack.kind !== kind
				? null
				: {
						size: inPack.bytes.length,
						bytes:
							maxBytes !== undefined && inPack.bytes.length > maxBytes
								? null
								: inPack.bytes,
					};
		return objects.read(
			oid,
			kind,
			maxBytes === undefined ? undefined : { maxBytes },
		);
	};
}

/**
 * Whether `next` extends `current`: a path of pushed commits leads from
 * `next` to `current`.
 */
export function extendsMain(
	pushed: Map<string, PackObject>,
	current: string,
	next: string,
): boolean {
	if (current === ZERO_OID || current === next) return true;
	const queue = [next];
	const seen = new Set<string>();
	while (queue.length > 0) {
		const oid = queue.shift() as string;
		if (oid === current) return true;
		if (seen.has(oid)) continue;
		seen.add(oid);
		const object = pushed.get(oid);
		if (object?.kind === 'commit')
			queue.push(...parseCommit(object.bytes).parents);
	}
	return false;
}

type Checked = { problem: string } | { pointers: Map<string, string> };

/**
 * Check every entry that each commit `next` brings to `main` changes
 * against its first parent: the LFS pointer rule, and no symlink or
 * submodule. The commits are every one `next` reaches and `current` does
 * not, from the pack or from the store: an object an earlier push stored
 * without its commit reaching `main` is checked the first time a push
 * reaches it. Commits in the pack are checked as they are; the walk stops
 * at a stored commit `current` reaches. Returns the pointers to verify, by
 * LFS oid, with a path that names each.
 */
export async function checkPushedTrees(
	objects: GitObjects,
	pushed: Map<string, PackObject>,
	next: string,
	current: string,
): Promise<Checked> {
	const read = objectSource(objects, pushed);
	const treeEntries = async (
		oid: string | null,
	): Promise<TreeEntry[] | null> => {
		if (oid === null) return [];
		const found = await read(oid, 'tree');
		return found?.bytes ? parseTree(found.bytes) : null;
	};
	const pointers = new Map<string, { size: number; path: string }>();
	const checkedBlobs = new Map<string, { oid: string; size: number } | null>();
	let problem: string | null = null;

	const checkFile = async (path: string, entry: TreeEntry, commit: string) => {
		if (entry.mode === '120000' || entry.mode === '160000') {
			problem = `${path} in ${commit.slice(0, 8)} is a ${entry.mode === '120000' ? 'symbolic link' : 'submodule'}, which a data folder does not hold`;
			return;
		}
		if (entry.mode !== '100644' && entry.mode !== '100755') {
			problem = `${path} in ${commit.slice(0, 8)} has unsupported mode ${entry.mode}`;
			return;
		}
		if (!storedWithLfs(path)) return;
		let pointer = checkedBlobs.get(entry.oid);
		if (pointer === undefined) {
			const found = await read(entry.oid, 'blob', MAX_POINTER_BYTES);
			pointer = found?.bytes ? readPointer(found.bytes) : null;
			checkedBlobs.set(entry.oid, pointer);
		}
		if (pointer === null) {
			problem = `${path} in ${commit.slice(0, 8)} is not a Git LFS pointer; files other than .md notes must be stored with Git LFS`;
			return;
		}
		pointers.set(pointer.oid, { size: pointer.size, path });
	};

	/** Every changed file between two trees, recursively. */
	const compare = async (
		before: string | null,
		after: string,
		prefix: string,
		commit: string,
	): Promise<void> => {
		if (before === after) return;
		const [old, now] = await Promise.all([
			treeEntries(before),
			treeEntries(after),
		]);
		if (now === null) {
			problem = `tree ${after.slice(0, 8)} in ${commit.slice(0, 8)} is missing`;
			return;
		}
		const previous = new Map((old ?? []).map((e) => [e.name, e]));
		for (const entry of now) {
			if (problem) return;
			const was = previous.get(entry.name);
			if (was && was.oid === entry.oid && was.mode === entry.mode) continue;
			const path = `${prefix}${entry.name}`;
			if (entry.mode === TREE_MODE)
				await compare(
					was?.mode === TREE_MODE ? was.oid : null,
					entry.oid,
					`${path}/`,
					commit,
				);
			else await checkFile(path, entry, commit);
		}
	};

	const visited = new Set<string>();
	const stack = [next];
	while (stack.length > 0 && problem === null) {
		const oid = stack.pop() as string;
		if (visited.has(oid)) continue;
		visited.add(oid);
		if (
			!pushed.has(oid) &&
			current !== ZERO_OID &&
			(await objects.isAncestor(oid, current))
		)
			continue;
		const object = await read(oid, 'commit');
		if (!object?.bytes) {
			problem = `commit ${oid.slice(0, 8)} is missing`;
			break;
		}
		const commit = parseCommit(object.bytes);
		const parent = commit.parents[0];
		let parentTree: string | null = null;
		if (parent !== undefined) {
			const found = await read(parent, 'commit');
			if (!found?.bytes) {
				problem = `parent ${parent.slice(0, 8)} of ${oid.slice(0, 8)} is missing`;
				break;
			}
			parentTree = parseCommit(found.bytes).tree;
		}
		await compare(parentTree, commit.tree, '', oid);
		stack.push(...commit.parents);
	}
	if (problem !== null) return { problem };
	return {
		pointers: new Map(
			[...pointers].map(([oid, { size, path }]) => [`${oid}:${size}`, path]),
		),
	};
}

/** A ref name for the `main` an owner's rewrite replaces, from `now`. */
export function replacedRef(now: Date): string {
	const stamp = now
		.toISOString()
		.replace(/[-:]/g, '')
		.replace('T', '-')
		.replace('.', '');
	return `refs/epicenter/replaced/${stamp}`;
}

/**
 * Receive one push: decide it, check it, and apply it atomically.
 * `mayRewrite` is whether the pusher owns the repository.
 */
export async function receivePush({
	objects,
	lfs,
	repositoryId,
	body,
	mayRewrite,
	now = () => new Date(),
}: {
	objects: GitObjects;
	lfs: LfsStore | null;
	repositoryId: string;
	body: Uint8Array;
	mayRewrite: boolean;
	now?: () => Date;
}): Promise<Response> {
	let parsed: ReturnType<typeof readCommandLines>;
	try {
		parsed = readCommandLines(body);
	} catch {
		return new Response('malformed push', { status: 400 });
	}
	const commands = parsed.lines.map((line) => {
		const [head = ''] = line.split('\0');
		const [old = '', next = '', ref = ''] = head.trim().split(' ');
		return { old, next, ref };
	});
	// Git's probe before a large push (`post_rpc`'s `probe_rpc`): a flush alone.
	if (commands.length === 0)
		return new Response(null, { status: 200, headers: resultHeaders });
	const first = commands[0] as (typeof commands)[number];
	const sideBand = / side-band-64k(?: |$)/.test(
		` ${parsed.lines[0]?.split('\0')[1]?.trim() ?? ''}`,
	);
	const reply = (ref: string, outcome: string) =>
		report(ref, outcome, sideBand);
	if (commands.length !== 1 || first.ref !== MAIN)
		return reply(
			commands.find((c) => c.ref !== MAIN)?.ref ?? first.ref,
			'only refs/heads/main may be pushed',
		);
	const { old, next } = first;
	if (next === ZERO_OID) return reply(MAIN, 'deleting main is not allowed');
	const current = (await objects.refs()).get(MAIN) ?? ZERO_OID;
	if (old !== current) return reply(MAIN, 'stale (main moved; fetch first)');

	let pushed: Map<string, PackObject>;
	try {
		pushed = readPack(parsed.rest);
	} catch (cause) {
		return reply(
			MAIN,
			`refused (pack: ${cause instanceof Error ? cause.message : 'unreadable'})`,
		);
	}
	const fastForward = extendsMain(pushed, current, next);
	if (!fastForward && !mayRewrite)
		return reply(
			MAIN,
			'non-fast-forward: only the repository owner may rewrite main; fetch, merge and push again',
		);
	const checked = await checkPushedTrees(objects, pushed, next, current);
	if ('problem' in checked) return reply(MAIN, `refused (${checked.problem})`);
	if (checked.pointers.size > 0) {
		const unverified = await Promise.all(
			[...checked.pointers].map(async ([key, path]) => {
				const [oid = '', size = ''] = key.split(':');
				const ok =
					lfs !== null &&
					LFS_OID.test(oid) &&
					(await lfs.verified(repositoryId, { oid, size: Number(size) }));
				return ok ? null : { oid, path };
			}),
		);
		const missing = unverified.find((u) => u !== null);
		if (missing)
			return reply(
				MAIN,
				`refused (Git LFS object ${missing.oid.slice(0, 12)} for ${missing.path} is not uploaded; push it with git lfs first)`,
			);
	}

	const updates = [{ ref: MAIN, old: current, next }];
	if (!fastForward && current !== ZERO_OID)
		updates.push({ ref: replacedRef(now()), old: ZERO_OID, next: current });
	const applied = await objects.apply(updates, parsed.rest);
	if (applied.ok) return reply(MAIN, 'ok');
	return reply(
		MAIN,
		applied.stale
			? 'stale (main moved; fetch first)'
			: `refused (${applied.reason})`,
	);
}
