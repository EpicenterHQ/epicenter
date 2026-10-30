/**
 * The `GitObjects` port over one Cloudflare Artifacts repository, so the
 * push receiver and the write translator run on the Worker exactly as on
 * disk (spike 6's `store()`, decision 51).
 *
 * - **Refs** come from the repository's receive-pack advertisement, which is
 *   what a compare-and-swap is checked against.
 * - **Objects** are read through the binding's repository handle, by kind:
 *   `readCommit`, `readTree` and `readBlob`. The 2026-10 binding types do not
 *   declare them; spike 6 measured their shapes (`ArtifactsReader`). A tree
 *   is rebuilt byte for byte from its entries. A commit is rebuilt from its
 *   parsed fields, which is enough to parse but not to hash: the binding
 *   gives no time zone or signature.
 * - **`apply`** is one `atomic` receive-pack. Artifacts checks every ref's
 *   old value and moves every ref or none (spike 6's probe: a stale `main`
 *   also refused the other ref), so an owner's rewrite moves `main` and its
 *   `refs/epicenter/replaced/*` backup together.
 *
 * The receiver walks `main`'s history once per push through `read`
 * (`receive.ts`, `mainReach`). The binding's undocumented `log()` (deployed
 * spike 8) might replace that walk; it is not used.
 */
import {
	type ApplyOutcome,
	FLUSH,
	type GitObjects,
	type ObjectKind,
	pktLine,
	readCommandLines,
	type TreeEntry,
	treeObject,
	writePack,
	ZERO_OID,
} from '@epicenter/server';

/** A commit as the binding's `readCommit` returns it (spike 6, `logs/probe.json`). */
export type ArtifactsCommit = {
	hash: string;
	treeHash: string;
	parents: string[];
	message: string;
	author: { name: string; email: string };
	committer: { name: string; email: string };
	authoredAt: number;
	committedAt: number;
};

/** A tree entry as `readTree` returns it: `mode` is `"100644"`, `"40000"`, and so on. */
export type ArtifactsTreeEntry = {
	name: string;
	mode: string | number;
	hash: string;
	type?: string;
};

/** The repository handle's object reads, which the binding types leave out. */
export type ArtifactsReader = {
	readCommit(oid: string): Promise<ArtifactsCommit | null>;
	readTree(oid: string): Promise<ArtifactsTreeEntry[] | null>;
	readBlob(
		oid: string,
	): Promise<{ size: number; arrayBuffer(): Promise<ArrayBuffer> } | null>;
	[Symbol.dispose]?(): void;
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Whether a binding read failed because the object is not there. */
function isMissing(cause: unknown): boolean {
	if (typeof cause !== 'object' || cause === null) return false;
	const { code, message } = cause as { code?: unknown; message?: unknown };
	return (
		code === 'NOT_FOUND' ||
		(typeof message === 'string' &&
			/not found|no such|does not exist/i.test(message))
	);
}

/** A tree entry's mode as Git writes it in a tree: octal, no leading zero. */
function treeMode(entry: ArtifactsTreeEntry): string {
	const mode =
		typeof entry.mode === 'number' ? entry.mode.toString(8) : entry.mode;
	return mode.replace(/^0+(?=\d)/, '');
}

/** The commit's text from its parsed fields, in Git's layout, with UTC times. */
export function commitText(commit: ArtifactsCommit): string {
	const sign = (who: { name: string; email: string }, at: number) =>
		`${who.name} <${who.email}> ${at} +0000`;
	return [
		`tree ${commit.treeHash}`,
		...commit.parents.map((parent) => `parent ${parent}`),
		`author ${sign(commit.author, commit.authoredAt)}`,
		`committer ${sign(commit.committer, commit.committedAt)}`,
		'',
		commit.message,
	].join('\n');
}

/** Every pkt-line of `body` before its flushes, across all sections. */
function pktLines(body: Uint8Array): string[] {
	const lines: string[] = [];
	let rest = body;
	while (rest.length >= 4) {
		const section = readCommandLines(rest);
		lines.push(...section.lines);
		if (section.rest.length === rest.length) break;
		rest = section.rest;
	}
	return lines;
}

export function createArtifactsObjects({
	remote,
	token,
	repository,
}: {
	/** `https://<account>.artifacts.cloudflare.net/git/<namespace>/<id>.git` */
	remote: string;
	/** A write token for this repository; `refused` drops it after Artifacts refuses it. */
	token: () => { value: Promise<string>; refused(): void };
	/** The binding's handle for this repository. */
	repository: () => Promise<ArtifactsReader>;
}): GitObjects {
	let handle: Promise<ArtifactsReader> | null = null;
	const reader = () => {
		handle ??= repository();
		return handle;
	};

	/** A request to the repository's Git endpoint with a write token. */
	async function upstream(
		path: string,
		init: RequestInit,
	): Promise<Uint8Array> {
		const credential = token();
		const response = await fetch(`${remote}${path}`, {
			...init,
			headers: {
				...(init.headers as Record<string, string>),
				authorization: `Basic ${btoa(`x:${await credential.value}`)}`,
			},
			redirect: 'manual',
		});
		const body = new Uint8Array(await response.arrayBuffer());
		if (response.status === 401 || response.status === 403)
			credential.refused();
		if (!response.ok)
			throw new Error(
				`Artifacts answered ${response.status} for ${path}: ${decoder.decode(body.subarray(0, 200))}`,
			);
		return body;
	}

	async function readContent(
		oid: string,
		kind: ObjectKind,
	): Promise<
		Uint8Array | { size: number; blob: () => Promise<ArrayBuffer> } | null
	> {
		const handle = await reader();
		try {
			if (kind === 'commit') {
				const commit = await handle.readCommit(oid);
				return commit && encoder.encode(commitText(commit));
			}
			if (kind === 'tree') {
				const entries = await handle.readTree(oid);
				return (
					entries &&
					treeObject(
						entries.map(
							(entry): TreeEntry => ({
								mode: treeMode(entry),
								name: entry.name,
								oid: entry.hash,
							}),
						),
					).bytes
				);
			}
			if (kind === 'blob') {
				const blob = await handle.readBlob(oid);
				return blob && { size: blob.size, blob: () => blob.arrayBuffer() };
			}
			return null;
		} catch (cause) {
			if (isMissing(cause)) return null;
			throw cause;
		}
	}

	return {
		async refs() {
			const body = await upstream('/info/refs?service=git-receive-pack', {
				method: 'GET',
			});
			const refs = new Map<string, string>();
			for (const line of pktLines(body)) {
				if (line.startsWith('#')) continue;
				const [head = ''] = line.replace(/\n$/, '').split('\0');
				const [oid = '', ref = ''] = head.split(' ');
				if (ref === '' || ref === 'capabilities^{}' || ref.endsWith('^{}'))
					continue;
				refs.set(ref, oid);
			}
			return refs;
		},
		async read(oid, kind, options) {
			const found = await readContent(oid, kind);
			if (found === null) return null;
			const maxBytes = options?.maxBytes ?? Number.POSITIVE_INFINITY;
			if (found instanceof Uint8Array)
				return {
					size: found.length,
					bytes: found.length > maxBytes ? null : found,
				};
			return {
				size: found.size,
				bytes:
					found.size > maxBytes ? null : new Uint8Array(await found.blob()),
			};
		},
		async apply(updates, pack): Promise<ApplyOutcome> {
			const commands = updates.map(({ ref, old, next }, index) =>
				pktLine(
					`${old} ${next} ${ref}${index === 0 ? '\0report-status atomic agent=epicenter' : ''}\n`,
				),
			);
			const sending = updates.some((update) => update.next !== ZERO_OID);
			const body = await upstream('/git-receive-pack', {
				method: 'POST',
				headers: {
					'content-type': 'application/x-git-receive-pack-request',
					accept: 'application/x-git-receive-pack-result',
				},
				body: new Blob([
					...commands,
					FLUSH,
					...(sending ? [pack ?? writePack([])] : []),
				] as BlobPart[]),
			});
			const lines = pktLines(body).map((line) => line.replace(/\n$/, ''));
			const unpack = lines.find((line) => line.startsWith('unpack '));
			if (unpack !== 'unpack ok')
				return {
					ok: false,
					stale: false,
					reason: unpack ?? `no report from Artifacts: ${lines.join(' | ')}`,
				};
			const refused = lines.filter((line) => line.startsWith('ng '));
			const reported = new Set(
				lines
					.filter((line) => line.startsWith('ok '))
					.map((line) => line.slice(3)),
			);
			if (refused.length === 0 && updates.every((u) => reported.has(u.ref)))
				return { ok: true };
			const reason = refused.join('; ') || lines.join(' | ');
			return { ok: false, stale: /stale|fetch first/i.test(reason), reason };
		},
		close() {
			const held = handle;
			handle = null;
			held
				?.then((repository) => repository[Symbol.dispose]?.())
				.catch(() => {});
		},
	};
}
