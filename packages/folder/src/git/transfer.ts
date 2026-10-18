/**
 * Browser Git's transfers: one branch fetched or pushed over Git's smart HTTP
 * protocol (`gitprotocol-http`, protocol v0), with isomorphic-git doing only
 * object work (reading objects, indexing a received pack, writing one to
 * send).
 *
 * Each transfer costs what changed, not what the history holds:
 *
 * ```txt
 * fetch   want the remote head; have the remote-tracking commit and the local
 *         branch head, so the server sends only what neither reaches
 * push    send the commits no advertised remote ref reaches, and in each only
 *         the trees and blobs none of its parents holds at the same path
 * ```
 *
 * isomorphic-git's `fetch` and `push` are not used: its fetch offers only the
 * branch head as a have, which the server does not know whenever the folder
 * holds a commit it has not pushed, so the whole history came back; its push
 * walked to the root whenever a merge's other parent was behind the remote
 * head, listing every tree of every commit on the way.
 */

import * as git from 'isomorphic-git';
import { REMOTE_MOVED } from './backend.js';
import type { HttpRequest } from './http.js';
import type { ObjectAccess } from './objects.js';

const ZERO = '0'.repeat(40);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

type Service = 'git-upload-pack' | 'git-receive-pack';

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

const FLUSH = encoder.encode('0000');

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

/** Reads pkt-lines from `bytes`: a payload, `null` for a flush, or `undefined` at the end. */
function pktReader(bytes: Uint8Array) {
	let offset = 0;
	return {
		get offset() {
			return offset;
		},
		next(): Uint8Array | null | undefined {
			if (offset + 4 > bytes.byteLength) return undefined;
			const length = Number.parseInt(
				decoder.decode(bytes.subarray(offset, offset + 4)),
				16,
			);
			if (Number.isNaN(length) || (length !== 0 && length < 4))
				throw new Error('The Git server sent a malformed response');
			if (length === 0) {
				offset += 4;
				return null;
			}
			const payload = bytes.subarray(offset + 4, offset + length);
			offset += length;
			return payload;
		},
	};
}

const text = (payload: Uint8Array) =>
	decoder.decode(payload).replace(/\n$/, '');

async function bodyOf(response: Response): Promise<Uint8Array> {
	return new Uint8Array(await response.arrayBuffer());
}

/** Refuse a reply that is not a success, as isomorphic-git named it. */
async function expectOk(response: Response): Promise<Uint8Array> {
	const body = await bodyOf(response);
	if (response.status !== 200)
		throw new git.Errors.HttpError(
			response.status,
			response.statusText,
			decoder.decode(body),
		);
	return body;
}

type Advertisement = {
	readonly refs: ReadonlyMap<string, string>;
	readonly capabilities: ReadonlySet<string>;
};

/** The refs and capabilities `url` advertises for `service`. */
async function discover(
	request: HttpRequest,
	url: string,
	service: Service,
	headers: Record<string, string>,
): Promise<Advertisement> {
	const body = await expectOk(
		await request(`${url}/info/refs?service=${service}`, { headers }),
	);
	const reader = pktReader(body);
	let line = reader.next();
	while (line === null) line = reader.next();
	if (line === undefined || text(line) !== `# service=${service}`) {
		const response = decoder.decode(body);
		throw new git.Errors.SmartHttpError(response.slice(0, 160), response);
	}
	const refs = new Map<string, string>();
	const capabilities = new Set<string>();
	line = reader.next();
	while (line === null) line = reader.next();
	if (line === undefined) return { refs, capabilities };
	const [first, offered = ''] = text(line).split('\0');
	for (const capability of offered.split(' '))
		if (capability !== '') capabilities.add(capability);
	// A repository with no refs advertises only its capabilities.
	if (first !== `${ZERO} capabilities^{}`) {
		const add = (entry: string) => {
			const [oid, name] = entry.split(' ');
			if (oid !== undefined && name !== undefined) refs.set(name, oid);
		};
		add(first ?? '');
		for (line = reader.next(); line != null; line = reader.next())
			add(text(line));
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

/**
 * Fetch `ref` from `url` into the object store, telling the server the
 * commits in `haves` that are stored here. Returns the remote's commit for
 * `ref`, or `undefined` when it has no such ref.
 */
export async function fetchRef({
	access,
	request,
	url,
	headers,
	ref,
	haves,
}: {
	access: ObjectAccess;
	request: HttpRequest;
	url: string;
	headers: Record<string, string>;
	ref: string;
	haves: readonly (string | undefined)[];
}): Promise<string | undefined> {
	const advertised = await discover(request, url, 'git-upload-pack', headers);
	const want = advertised.refs.get(ref);
	if (want === undefined) return undefined;
	const capabilities = ['side-band-64k', 'ofs-delta'].filter((capability) =>
		advertised.capabilities.has(capability),
	);
	const sideBand = capabilities.includes('side-band-64k');
	const lines = [
		pktLine(`${['want', want, ...capabilities].join(' ')}\n`),
		FLUSH,
	];
	for (const have of new Set(haves))
		if (have !== undefined && (await present(access, have)))
			lines.push(pktLine(`have ${have}\n`));
	lines.push(pktLine('done\n'));
	const body = await expectOk(
		await request(`${url}/git-upload-pack`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/x-git-upload-pack-request',
				accept: 'application/x-git-upload-pack-result',
			},
			body: concat(lines),
		}),
	);

	// Without multi_ack the server answers one ACK for the first have it
	// knows, or NAK, and then the pack.
	const reader = pktReader(body);
	const answer = reader.next();
	const said = answer == null ? '' : text(answer);
	if (said.startsWith('ERR ')) throw new Error(said.slice(4));
	if (said !== 'NAK' && !said.startsWith('ACK '))
		throw new Error('The Git server sent a malformed response');
	let pack: Uint8Array;
	if (sideBand) {
		const parts: Uint8Array[] = [];
		for (let line = reader.next(); line != null; line = reader.next()) {
			if (line[0] === 1) parts.push(line.subarray(1));
			else if (line[0] === 3) throw new Error(text(line.subarray(1)));
		}
		pack = concat(parts);
	} else pack = body.subarray(reader.offset);

	if (pack.byteLength < 32 || decoder.decode(pack.subarray(0, 4)) !== 'PACK')
		throw new Error('The Git server sent no pack');
	const count = new DataView(pack.buffer, pack.byteOffset + 8, 4).getUint32(0);
	if (count > 0) {
		const name = [...pack.subarray(-20)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		const filepath = `objects/pack/pack-${name}.pack`;
		await access.fs.promises.writeFile(`${access.gitdir}/${filepath}`, pack);
		await git.indexPack({ ...access, dir: access.gitdir, filepath });
	}
	return want;
}

type Walked = {
	readonly parents: readonly string[];
	readonly tree: string;
	readonly time: number;
	/** Reachable from a ref the remote advertised, so the remote holds it. */
	held: boolean;
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
	/** Commits whose parents are not visited yet, newest first. */
	const queue: Walked[] = [];
	const hold = (walked: Walked) => {
		const pending = [walked];
		for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
			if (next.held) continue;
			next.held = true;
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
			parents: commit.parent,
			tree: commit.tree,
			time: commit.committer.timestamp,
			held,
		};
		seen.set(oid, walked);
		let at = queue.length;
		while (at > 0 && (queue[at - 1]?.time ?? 0) < walked.time) at--;
		queue.splice(at, 0, walked);
	}
	for (const oid of held)
		if (await present(access, oid)) await visit(oid, true);
	await visit(start, false);
	for (
		let walked = queue.shift();
		walked !== undefined;
		walked = queue.shift()
	) {
		for (const parent of walked.parents) await visit(parent, walked.held);
		if (queue.every((next) => next.held)) break;
	}
	return new Map([...seen].filter(([, walked]) => !walked.held));
}

/**
 * Add to `objects` tree `oid` and everything under it that no tree in
 * `bases` holds at the same path. A base is a parent commit's tree, which
 * the remote holds or this push sends.
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
	request,
	url,
	headers,
	ref,
	oid,
}: {
	access: ObjectAccess;
	request: HttpRequest;
	url: string;
	headers: Record<string, string>;
	ref: string;
	oid: string;
}): Promise<'pushed' | 'rejected'> {
	const advertised = await discover(request, url, 'git-receive-pack', headers);
	if (!advertised.capabilities.has('report-status'))
		throw new Error('The Git server does not report the result of a push');
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

	const objects = new Set<string>();
	const commits = await newCommits(access, oid, advertised.refs.values());
	for (const [commit, { tree, parents }] of commits) {
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
	const body = await expectOk(
		await request(`${url}/git-receive-pack`, {
			method: 'POST',
			headers: {
				...headers,
				'content-type': 'application/x-git-receive-pack-request',
				accept: 'application/x-git-receive-pack-result',
			},
			body: concat([
				pktLine(`${old} ${oid} ${ref}\0report-status\n`),
				FLUSH,
				packfile,
			]),
		}),
	);

	const reader = pktReader(body);
	const unpack = text(reader.next() ?? new Uint8Array());
	if (unpack !== 'unpack ok')
		throw new Error(
			unpack.startsWith('unpack ')
				? `The remote could not unpack the push: ${unpack.slice(7)}`
				: 'The Git server sent a malformed response',
		);
	for (let line = reader.next(); line != null; line = reader.next()) {
		const status = text(line);
		if (status === `ok ${ref}`) return 'pushed';
		if (status.startsWith(`ng ${ref} `)) {
			const reason = status.slice(`ng ${ref} `.length);
			if (REMOTE_MOVED.test(reason)) return 'rejected';
			throw new Error(reason);
		}
	}
	throw new Error('The remote did not report the push');
}
