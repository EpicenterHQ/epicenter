/**
 * A store over a repository on the server (ADR-0773, ADR-0779). A version
 * is the Git blob id on `main` (for a file kept with Git LFS, the blob of
 * its pointer): a listing knows it without reading a file.
 *
 * A note travels as text; any other file's bytes travel as a Git LFS object,
 * uploaded before the write names it and downloaded when the file is read.
 * `read` asks for every path in one request, all from one commit of `main`.
 *
 * A write lands only while the path holds what its writer expects: it
 * carries that as its `base` (null for `'absent'`), which the server checks
 * in the step that moves `main`, and a refusal (`occupied` or `stale`) is
 * `'stale'` here. The server never merges (ADR-0773).
 *
 * A watch asks the server where `main` is before it answers, so a change
 * made after it answers is heard; then, every `POLL_MS`, it asks for the
 * paths changed since the commit it last saw, and the server answers them
 * from the two trees. The server becoming unreachable is heard as `'all'`:
 * what a reader can show may have changed, and its next listing says why
 * not. It stops with the stop it answered, or with the account.
 */

import { ClientError, storedWithLfs } from '@epicenter/definition/contract';
import { isNamespaceId, isRepositoryName } from '@epicenter/definition/site';
import { Ok, type Result } from 'wellcrafted/result';
import type { FileRead, Store, Unavailable, Version } from '../device/store.js';
import {
	createWire,
	type FileWrite,
	type RemoteAccount,
	RemoteError,
	type WriteAnswer,
} from './wire.js';

/** How often a watch asks the server what changed. */
const POLL_MS = 3000;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** `Unavailable` for an answer the store does not expect. */
const refused = (answer: {
	status: number;
	code: string | null;
	message: string;
}) => ClientError.Unavailable({ cause: RemoteError.Refused(answer).error });

/** A refusal that means the path does not hold what the write expected. */
const STALE_CODES = new Set(['occupied', 'stale']);

/**
 * The store of `repository` (`<owner>/<name>`, `~` for the account's own) as
 * `account` reaches it, asking what changed every `pollMs` while watched. A
 * `repository` that names none throws.
 */
export function repositoryStore(
	account: RemoteAccount,
	repository: string,
	{ pollMs = POLL_MS }: { pollMs?: number } = {},
): Store {
	const [owner = '', name = '', extra] = repository.split('/');
	if (
		extra !== undefined ||
		(owner !== '~' && !isNamespaceId(owner)) ||
		!isRepositoryName(name)
	)
		throw new Error(
			`'${repository}' names no repository: use <owner>/<name>, where <owner> is a person's handle or ~`,
		);
	const wire = createWire(account, repository);

	/** One file's write: the receipt, `'stale'` for a refusal of its expectation. */
	async function send(file: FileWrite) {
		const written = await wire.write({ files: [file] });
		if (written.error !== null) return written;
		const answer: WriteAnswer = written.data;
		if (answer.landed) return Ok(answer.receipt);
		if (answer.code !== null && STALE_CODES.has(answer.code))
			return Ok('stale' as const);
		return refused(answer);
	}

	return {
		async list(under) {
			const listed = await wire.list(under);
			if (listed.error !== null) return listed;
			return Ok(
				listed.data.map(({ path, blob, lfs }) => ({
					path,
					version: blob,
					size: lfs?.size ?? null,
				})),
			);
		},
		async read(paths): Promise<Result<FileRead[], Unavailable>> {
			if (paths.length === 0) return Ok([]);
			const read = await wire.read(paths);
			if (read.error !== null) return read;
			const files: FileRead[] = [];
			for (const file of read.data) {
				if ('gone' in file) {
					files.push({ path: file.path, gone: true });
					continue;
				}
				const { path, blob, text, lfs } = file;
				if (typeof text === 'string') {
					files.push({ path, bytes: encoder.encode(text), version: blob });
					continue;
				}
				if (!lfs)
					return refused({
						status: 200,
						code: 'not_lfs',
						message: `${path} is not a Git LFS pointer on main`,
					});
				const bytes = await wire.download(lfs);
				if (bytes.error !== null) return bytes;
				files.push({ path, bytes: bytes.data, version: blob });
			}
			return Ok(files);
		},
		async write(path, bytes, over) {
			if (bytes === null) {
				// Removing nothing where nothing is lands, as on a device.
				if (over === 'absent') {
					const there = await wire.read([path]);
					if (there.error !== null) return there;
					return Ok(there.data[0] && 'gone' in there.data[0] ? null : 'stale');
				}
				const sent = await send({ path, delete: true, base: over });
				if (sent.error !== null) return sent;
				return Ok(sent.data === 'stale' ? sent.data : null);
			}
			const base: Version | null = over === 'absent' ? null : over;
			let file: FileWrite;
			if (storedWithLfs(path)) {
				const uploaded = await wire.upload([bytes]);
				if (uploaded.error !== null) return uploaded;
				const [lfs] = uploaded.data;
				if (lfs === undefined) throw new Error('one object for one file');
				file = { path, lfs, base };
			} else file = { path, text: decoder.decode(bytes), base };
			const sent = await send(file);
			if (sent.error !== null) return sent;
			if (sent.data === 'stale') return sent;
			const landed = sent.data.blobs[path] as Version | null | undefined;
			if (landed === null || landed === undefined)
				return refused({
					status: 200,
					code: 'no_blob',
					message: `the write of ${path} landed no file there`,
				});
			return Ok(landed);
		},
		async watch(changed) {
			if (account.signal.aborted)
				return ClientError.Unavailable({ cause: 'the account was retired' });
			const first = await wire.changes();
			if (first.error !== null) return first;
			/** The commit `main` was at when last asked. */
			let seen = first.data.commit;
			let reachable = true;
			let stopped = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			async function poll() {
				if (stopped || account.signal.aborted) return;
				const asked = await wire.changes(seen);
				if (stopped) return;
				if (asked.error !== null) {
					if (reachable) changed('all');
					reachable = false;
				} else {
					reachable = true;
					const { commit, paths } = asked.data;
					seen = commit;
					if (paths === null) changed('all');
					else if (paths.length > 0) changed(paths);
				}
				timer = setTimeout(poll, pollMs);
			}
			timer = setTimeout(poll, pollMs);
			return Ok(() => {
				stopped = true;
				clearTimeout(timer);
			});
		},
		close() {},
	};
}
