/**
 * A scripted smart-HTTP Git remote and a small history to move across it.
 *
 * The remote speaks just enough of the wire protocol for isomorphic-git to
 * parse: an advertisement, then whatever reply the test scripts for the POST.
 * It records every request so a test can tell what was and was not sent.
 */
import * as git from 'isomorphic-git';
import {
	type GitObject,
	hashObject,
	type TreeEntry,
	writeCommit,
	writeTree,
} from './objects.js';
import { createScratchFs } from './transfer-fs.js';

const encoder = new TextEncoder();
export const ZERO = '0'.repeat(40);

function concat(parts: readonly Uint8Array[]) {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.length;
	}
	return out;
}

export function pkt(data: string | Uint8Array) {
	const bytes = typeof data === 'string' ? encoder.encode(data) : data;
	const length = (bytes.length + 4).toString(16).padStart(4, '0');
	return concat([encoder.encode(length), bytes]);
}

export const flush = () => encoder.encode('0000');

export type Exchange = { method: string; url: string; body: string };

export type Reply = Response | Uint8Array | string;

export function reply(body: Uint8Array | string, contentType?: string) {
	return new Response(
		(typeof body === 'string'
			? encoder.encode(body)
			: body) as Uint8Array<ArrayBuffer>,
		contentType === undefined
			? undefined
			: { headers: { 'content-type': contentType } },
	);
}

/** A reply whose body fails after `sent`, as a dropped connection does. */
export function dropped(sent: Uint8Array) {
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(sent);
				controller.error(new Error('connection reset'));
			},
		}),
	);
}

const UPLOAD_CAPABILITIES =
	'multi_ack_detailed no-done side-band-64k ofs-delta shallow deepen-since deepen-not symref=HEAD:refs/heads/main agent=git/2';
const RECEIVE_CAPABILITIES =
	'report-status side-band-64k ofs-delta agent=git/2';

function advertisement(
	service: 'git-upload-pack' | 'git-receive-pack',
	refs: readonly (readonly [name: string, oid: string])[],
) {
	const capabilities =
		service === 'git-upload-pack' ? UPLOAD_CAPABILITIES : RECEIVE_CAPABILITIES;
	const lines =
		refs.length === 0
			? [pkt(`${ZERO} capabilities^{}\0${capabilities}\n`)]
			: refs.map(([name, oid], index) =>
					pkt(`${oid} ${name}${index === 0 ? `\0${capabilities}` : ''}\n`),
				);
	return reply(
		concat([pkt(`# service=${service}\n`), flush(), ...lines, flush()]),
		`application/x-${service}-advertisement`,
	);
}

/** What an upload-pack server answers: shallow boundary lines, NAK, then the pack. */
export function uploadPackReply({
	pack,
	shallow = [],
}: {
	pack: Uint8Array;
	shallow?: readonly string[];
}) {
	const bands: Uint8Array[] = [];
	for (let offset = 0; offset < pack.length; offset += 60000) {
		bands.push(
			pkt(concat([Uint8Array.of(1), pack.subarray(offset, offset + 60000)])),
		);
	}
	return reply(
		concat([
			...(shallow.length > 0
				? [...shallow.map((oid) => pkt(`shallow ${oid}\n`)), flush()]
				: []),
			pkt('NAK\n'),
			...bands,
			flush(),
		]),
		'application/x-git-upload-pack-result',
	);
}

/** What a receive-pack server answers: its report-status, inside side-band 1. */
export function receivePackReply(lines: readonly string[]) {
	const report = concat([...lines.map((line) => pkt(`${line}\n`)), flush()]);
	return reply(
		concat([pkt(concat([Uint8Array.of(1), report])), flush()]),
		'application/x-git-receive-pack-result',
	);
}

export function remote({
	refs,
	post,
	unauthorized = false,
}: {
	/** What `main` and other branches are at, as the advertisement lists them. */
	refs: readonly (readonly [name: string, oid: string])[];
	post?: (body: string) => Reply;
	unauthorized?: boolean;
}) {
	const calls: Exchange[] = [];
	const request = (async (
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> => {
		const url = String(input);
		const method = init?.method ?? 'GET';
		const body =
			init?.body instanceof Uint8Array
				? new TextDecoder('latin1').decode(init.body)
				: '';
		calls.push({ method, url, body });
		if (unauthorized) return new Response('denied', { status: 401 });
		if (method === 'GET') {
			const service = url.includes('git-receive-pack')
				? 'git-receive-pack'
				: 'git-upload-pack';
			return advertisement(service, refs);
		}
		if (post === undefined) throw new Error(`unexpected POST to ${url}`);
		const answer = post(body);
		return typeof answer === 'string' || answer instanceof Uint8Array
			? reply(answer)
			: answer;
	}) as typeof fetch;
	return {
		request,
		calls,
		posts: () => calls.filter((c) => c.method === 'POST'),
	};
}

/** A packfile holding exactly `oids`, built by isomorphic-git from `objects`. */
export async function packOf(
	objects: ReadonlyMap<string, GitObject>,
	oids: readonly string[],
) {
	const fs = createScratchFs();
	const gitdir = '/pack';
	await git.init({ fs, gitdir, bare: true });
	for (const oid of oids) {
		const { type, bytes } = objects.get(oid)!;
		await git.writeObject({
			fs,
			gitdir,
			type,
			object: bytes,
			format: 'content',
		});
	}
	const { packfile } = await git.packObjects({
		fs,
		gitdir,
		oids: [...oids],
		write: false,
	});
	return packfile!;
}

async function put(objects: Map<string, GitObject>, object: GitObject) {
	const oid = await hashObject(object);
	objects.set(oid, object);
	return oid;
}

const GITLINK = 'a'.repeat(40);

/**
 * Three commits, each tree carrying a gitlink to a commit nobody has:
 * c1 { a.md, sub }, c2 adds dir/b.md, c3 rewrites a.md.
 */
export async function history() {
	const objects = new Map<string, GitObject>();
	const blob = (text: string) =>
		put(objects, { type: 'blob', bytes: encoder.encode(text) });
	const tree = (entries: TreeEntry[]) =>
		put(objects, { type: 'tree', bytes: writeTree(entries) });
	const commit = (treeOid: string, parents: string[], message: string) =>
		put(objects, {
			type: 'commit',
			bytes: writeCommit({
				tree: treeOid,
				parents,
				author: { name: 'A', email: 'a@example.com', timestamp: 1_700_000_000 },
				message,
			}),
		});
	const entry = (name: string, mode: string, oid: string): TreeEntry => ({
		name: encoder.encode(name),
		mode,
		oid,
	});
	const sub = entry('sub', '160000', GITLINK);

	const b1 = await blob('one\n');
	const b2 = await blob('two\n');
	const b3 = await blob('three\n');
	const t1 = await tree([entry('a.md', '100644', b1), sub]);
	const c1 = await commit(t1, [], 'first\n');
	const d2 = await tree([entry('b.md', '100644', b2)]);
	const t2 = await tree([
		entry('a.md', '100644', b1),
		entry('dir', '40000', d2),
		sub,
	]);
	const c2 = await commit(t2, [c1], 'second\n');
	const t3 = await tree([
		entry('a.md', '100644', b3),
		entry('dir', '40000', d2),
		sub,
	]);
	const c3 = await commit(t3, [c2], 'third\n');
	const unrelated = await commit(t1, [], 'unrelated\n');

	/** The objects a snapshot of `commit` alone adds over its parent's. */
	const added = {
		c1: [c1, t1, b1],
		c2: [c2, t2, d2, b2],
		c3: [c3, t3, b3],
	};
	const pick = (oids: readonly string[]) =>
		new Map(oids.map((oid) => [oid, objects.get(oid)!]));
	return {
		objects,
		pick,
		c1,
		c2,
		c3,
		unrelated,
		b1,
		b2,
		b3,
		t1,
		t2,
		t3,
		d2,
		added,
	};
}
