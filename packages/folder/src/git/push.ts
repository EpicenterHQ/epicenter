/**
 * Browser Git's push: one commit sent to one branch over Git's smart HTTP
 * protocol (`gitprotocol-http`, protocol v0), with isomorphic-git doing only
 * object work (reading commits and trees, writing the pack).
 *
 * A push costs what changed, not what the history holds. It sends the
 * commits no ref the remote advertised reaches, and of each only the trees
 * and blobs none of its parents holds at the same path. Commits are taken
 * parents first, so every parent is either held by the remote or already
 * fully in the pack when a child's tree is compared with it.
 *
 * isomorphic-git's `push` is not used: it walked to the root whenever a
 * merge's other parent was behind the remote head, which is Sync's ordinary
 * merge, listing every tree of every commit on the way.
 */

import * as git from 'isomorphic-git';
import { REMOTE_MOVED } from './backend.js';
import type { ObjectAccess } from './objects.js';

const ZERO = '0'.repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SERVICE = 'git-receive-pack';

/** One pkt-line holding `line`. */
function pktLine(line: string): Uint8Array {
	const bytes = encoder.encode(line);
	const framed = new Uint8Array(bytes.byteLength + 4);
	framed.set(
		encoder.encode((bytes.byteLength + 4).toString(16).padStart(4, '0')),
	);
	framed.set(bytes, 4);
	return framed;
}

function concat(parts: readonly Uint8Array[]): Uint8Array {
	const bytes = new Uint8Array(
		parts.reduce((size, part) => size + part.byteLength, 0),
	);
	let offset = 0;
	for (const part of parts) {
		bytes.set(part, offset);
		offset += part.byteLength;
	}
	return bytes;
}

const malformed = () => new Error('The Git server sent a malformed response');

/** The pkt-lines of `bytes`: each payload as text, `null` for a flush. */
function* pktLines(bytes: Uint8Array): Generator<string | null> {
	let offset = 0;
	while (offset + 4 <= bytes.byteLength) {
		const length = Number.parseInt(
			decoder.decode(bytes.subarray(offset, offset + 4)),
			16,
		);
		if (Number.isNaN(length) || (length !== 0 && length < 4)) throw malformed();
		if (length === 0) {
			offset += 4;
			yield null;
			continue;
		}
		yield decoder
			.decode(bytes.subarray(offset + 4, offset + length))
			.replace(/\n$/, '');
		offset += length;
	}
}

/** One request's reply body, refused unless it is a success. */
async function send(
	http: git.HttpClient,
	request: git.GitHttpRequest,
): Promise<Uint8Array> {
	const response = await http.request(request);
	const chunks: Uint8Array[] = [];
	for await (const chunk of response.body ?? []) chunks.push(chunk);
	const body = concat(chunks);
	if (response.statusCode !== 200)
		throw new git.Errors.HttpError(
			response.statusCode,
			response.statusMessage,
			decoder.decode(body),
		);
	return body;
}

type Advertisement = {
	readonly refs: ReadonlyMap<string, string>;
	readonly capabilities: ReadonlySet<string>;
};

const REF_LINE = /^([0-9a-f]{40}) (\S+)$/;

/** The refs and capabilities `url` advertises for receive-pack. */
async function discover(
	http: git.HttpClient,
	url: string,
	headers: Record<string, string>,
): Promise<Advertisement> {
	const body = await send(http, {
		url: `${url}/info/refs?service=${SERVICE}`,
		method: 'GET',
		headers,
	});
	const lines = [...pktLines(body)].filter((line) => line !== null);
	if (lines[0] !== `# service=${SERVICE}`) {
		const response = decoder.decode(body);
		throw new git.Errors.SmartHttpError(response.slice(0, 160), response);
	}
	const refs = new Map<string, string>();
	const capabilities = new Set<string>();
	const [first, ...rest] = lines.slice(1);
	if (first === undefined) return { refs, capabilities };
	if (first.startsWith('version 2'))
		throw new Error(
			`${url} answered with Git protocol version 2, which a browser folder does not push over`,
		);
	const [head = '', offered = ''] = first.split('\0');
	for (const capability of offered.split(' '))
		if (capability !== '') capabilities.add(capability);
	// A repository with no refs advertises only its capabilities.
	const entries = head === `${ZERO} capabilities^{}` ? rest : [head, ...rest];
	for (const entry of entries) {
		const match = REF_LINE.exec(entry);
		if (match === null)
			throw new Error(`${url} advertised a line that names no ref: ${entry}`);
		refs.set(match[2] as string, match[1] as string);
	}
	return { refs, capabilities };
}

async function present(access: ObjectAccess, oid: string): Promise<boolean> {
	try {
		await git.readCommit({ ...access, oid });
		return true;
	} catch {
		return false;
	}
}

type Walked = {
	readonly oid: string;
	readonly parents: readonly string[];
	readonly tree: string;
	readonly time: number;
	/** Reachable from a ref the remote advertised, so the remote holds it. */
	held: boolean;
	/** Still waiting for its parents to be visited. */
	queued: boolean;
};

/**
 * The commits reachable from `start` and from none of `held`, which the
 * remote advertised. Commits are visited newest first, and the walk stops
 * once every commit still queued is one the remote holds, as Git's own
 * revision walk does. A clock skewed enough to stop it early only makes a
 * held commit look new, which sends objects the remote already has.
 */
async function newCommits(
	access: ObjectAccess,
	start: string,
	held: Iterable<string>,
): Promise<Map<string, Walked>> {
	const seen = new Map<string, Walked>();
	/** Commits whose parents are not visited yet, oldest first. */
	const queue: Walked[] = [];
	/** How many queued commits the remote is not known to hold. */
	let unheld = 0;
	const hold = (walked: Walked) => {
		const pending = [walked];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			if (next.held) continue;
			next.held = true;
			if (next.queued) unheld--;
			for (const parent of next.parents) {
				const known = seen.get(parent);
				if (known !== undefined) pending.push(known);
			}
		}
	};
	async function visit(oid: string, held: boolean) {
		const known = seen.get(oid);
		if (known !== undefined) {
			if (held) hold(known);
			return;
		}
		const { commit } = await git.readCommit({ ...access, oid });
		const walked: Walked = {
			oid,
			parents: commit.parent,
			tree: commit.tree,
			time: commit.committer.timestamp,
			held,
			queued: true,
		};
		seen.set(oid, walked);
		if (!held) unheld++;
		let low = 0;
		let high = queue.length;
		while (low < high) {
			const middle = (low + high) >> 1;
			if ((queue[middle]?.time ?? 0) <= walked.time) low = middle + 1;
			else high = middle;
		}
		queue.splice(low, 0, walked);
	}
	for (const oid of held)
		if (await present(access, oid)) await visit(oid, true);
	await visit(start, false);
	while (unheld > 0) {
		const walked = queue.pop();
		if (walked === undefined) break;
		walked.queued = false;
		if (!walked.held) unheld--;
		for (const parent of walked.parents) await visit(parent, walked.held);
	}
	return new Map([...seen].filter(([, walked]) => !walked.held));
}

/** `commits` ordered so each comes after every parent among them. */
function parentsFirst(commits: ReadonlyMap<string, Walked>): Walked[] {
	const waiting = new Map<string, number>();
	const children = new Map<string, string[]>();
	const ready: Walked[] = [];
	for (const walked of commits.values()) {
		const parents = new Set(walked.parents.filter((oid) => commits.has(oid)));
		waiting.set(walked.oid, parents.size);
		for (const parent of parents) {
			const list = children.get(parent);
			if (list === undefined) children.set(parent, [walked.oid]);
			else list.push(walked.oid);
		}
		if (parents.size === 0) ready.push(walked);
	}
	const order: Walked[] = [];
	for (let next = ready.pop(); next !== undefined; next = ready.pop()) {
		order.push(next);
		for (const child of children.get(next.oid) ?? []) {
			const left = (waiting.get(child) ?? 0) - 1;
			waiting.set(child, left);
			const walked = commits.get(child);
			if (left === 0 && walked !== undefined) ready.push(walked);
		}
	}
	return order;
}

/**
 * Add to `objects` tree `oid` and everything under it that no tree in
 * `bases` holds at the same path. A base is a parent commit's tree, which
 * the remote holds or `objects` already holds entirely, so a tree once added
 * is complete and is never expanded again.
 */
async function addTree(
	access: ObjectAccess,
	objects: Set<string>,
	oid: string,
	bases: readonly string[],
): Promise<void> {
	if (objects.has(oid) || bases.includes(oid)) return;
	objects.add(oid);
	const read = (tree: string) => git.readTree({ ...access, oid: tree });
	const [{ tree }, baseTrees] = await Promise.all([
		read(oid),
		Promise.all(bases.map(read)),
	]);
	const byPath = baseTrees.map(
		(base) => new Map(base.tree.map((entry) => [entry.path, entry])),
	);
	for (const entry of tree) {
		const same = byPath.map((base) => base.get(entry.path));
		if (same.some((base) => base?.oid === entry.oid)) continue;
		if (entry.type === 'blob') objects.add(entry.oid);
		else if (entry.type === 'tree')
			await addTree(
				access,
				objects,
				entry.oid,
				same.flatMap((base) => (base?.type === 'tree' ? [base.oid] : [])),
			);
	}
}

/**
 * Push commit `oid` to `ref` at `url`, never forcing: `rejected` when the
 * remote's `ref` is not an ancestor of `oid`, or moved before the update.
 */
export async function pushRef({
	access,
	http,
	url,
	headers,
	ref,
	oid,
}: {
	access: ObjectAccess;
	http: git.HttpClient;
	url: string;
	headers: Record<string, string>;
	ref: string;
	oid: string;
}): Promise<'pushed' | 'rejected'> {
	const advertised = await discover(http, url, headers);
	if (!advertised.capabilities.has('report-status'))
		throw new Error(`${url} does not report the result of a push`);
	const old = advertised.refs.get(ref) ?? ZERO;
	if (old === oid) return 'pushed';
	if (
		old !== ZERO &&
		!(
			(await present(access, old)) &&
			(await git.isDescendent({ ...access, oid, ancestor: old, depth: -1 }))
		)
	)
		return 'rejected';

	const commits = await newCommits(access, oid, advertised.refs.values());
	const objects = new Set<string>();
	for (const { oid: commit, tree, parents } of parentsFirst(commits)) {
		objects.add(commit);
		const bases = await Promise.all(
			parents.map(
				async (parent) =>
					commits.get(parent)?.tree ??
					(await git.readCommit({ ...access, oid: parent })).commit.tree,
			),
		);
		await addTree(access, objects, tree, bases);
	}
	const { packfile } = await git.packObjects({
		...access,
		oids: [...objects],
	});
	if (packfile === undefined) throw new Error('No pack was written to push');
	const body = await send(http, {
		url: `${url}/${SERVICE}`,
		method: 'POST',
		headers: {
			...headers,
			'content-type': `application/x-${SERVICE}-request`,
			accept: `application/x-${SERVICE}-result`,
		},
		body: (async function* () {
			yield pktLine(`${old} ${oid} ${ref}\0report-status\n`);
			yield encoder.encode('0000');
			yield packfile;
		})(),
	});

	const [unpack, ...statuses] = pktLines(body);
	if (unpack !== 'unpack ok')
		throw unpack?.startsWith('unpack ')
			? new Error(`The remote could not unpack the push: ${unpack.slice(7)}`)
			: malformed();
	for (const status of statuses) {
		if (status === `ok ${ref}`) return 'pushed';
		if (status?.startsWith(`ng ${ref} `)) {
			const reason = status.slice(`ng ${ref} `.length);
			if (REMOTE_MOVED.test(reason)) return 'rejected';
			throw new Error(reason);
		}
	}
	throw new Error('The remote did not report the push');
}
