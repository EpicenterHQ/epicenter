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
 * carries that as its `base` (null for nothing), which the server checks
 * in the step that moves `main`, and a refusal (`occupied` or `stale`) is
 * `Moved` here, carrying what the path holds. The server never merges (ADR-0773).
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
import {
	type BlobId,
	type FileRead,
	type Store,
	StoreError,
	type Unavailable,
} from '../device/store.js';
import type {
	BatchRefusal,
	BatchWrite,
	RemoteFile,
	Repository,
} from '../sync/repository.js';
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
): Store & Repository {
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

	/**
	 * The files at `paths` on `main`, or at the commit `at`, in one request:
	 * a note's text as bytes, and an attachment's bytes downloaded only with
	 * `attachments` (null otherwise).
	 */
	async function readFiles(
		paths: readonly string[],
		at: string | undefined,
		attachments: boolean,
	): Promise<Result<RemoteFile[], Unavailable>> {
		if (paths.length === 0) return Ok([]);
		const read = await wire.read(paths, at);
		if (read.error !== null) return read;
		const files: RemoteFile[] = [];
		for (const file of read.data.files) {
			if ('gone' in file) {
				files.push({ path: file.path, gone: true });
				continue;
			}
			const { path, blob, text, lfs } = file;
			if (typeof text === 'string') {
				files.push({ path, version: blob, bytes: encoder.encode(text) });
				continue;
			}
			if (!lfs)
				return refused({
					status: 200,
					code: 'not_lfs',
					message: `${path} is not a Git LFS pointer`,
				});
			if (!attachments) {
				files.push({ path, version: blob, bytes: null });
				continue;
			}
			const bytes = await wire.download(lfs);
			if (bytes.error !== null) return bytes;
			files.push({ path, version: blob, bytes: bytes.data });
		}
		return Ok(files);
	}

	/**
	 * One write request: the receipt, `'stale'` for a refusal of its
	 * expectation, and a `BatchRefusal` for a path that differs only in case
	 * from one the repository holds.
	 */
	async function send(files: FileWrite[]) {
		const written = await wire.write({ files });
		if (written.error !== null) return written;
		const answer: WriteAnswer = written.data;
		if (answer.landed) return Ok(answer.receipt);
		if (answer.code !== null && STALE_CODES.has(answer.code))
			return Ok('stale' as const);
		if (answer.code === 'case_collision' && answer.path !== null)
			return Ok({
				refused: answer.path,
				reason: answer.message,
			} satisfies BatchRefusal);
		return refused(answer);
	}

	return {
		async list(under) {
			const listed = await wire.list(under);
			if (listed.error !== null) return listed;
			return Ok(
				listed.data.files.map(({ path, blob, lfs }) => ({
					path,
					version: blob,
					size: lfs?.size ?? null,
				})),
			);
		},
		async read(paths): Promise<Result<FileRead[], Unavailable>> {
			const read = await readFiles(paths, undefined, true);
			if (read.error !== null) return read;
			return Ok(
				read.data.map((file) =>
					'gone' in file || file.bytes === null
						? { path: file.path, gone: true as const }
						: { path: file.path, bytes: file.bytes, version: file.version },
				),
			);
		},
		async put(path, bytes, expect) {
			/** What the path holds now, as `Moved`. */
			const moved = async () => {
				const there = await wire.read([path]);
				if (there.error !== null) return there;
				const [file] = there.data.files;
				return StoreError.Moved({
					path,
					now: file === undefined || 'gone' in file ? null : file.blob,
				});
			};
			if (bytes === null) {
				// Removing nothing where nothing is lands, as on a device.
				if (expect === null) {
					const now = await moved();
					return now.error?.name === 'Moved' && now.error.now === null
						? Ok(null)
						: now;
				}
				const sent = await send([{ path, delete: true, base: expect }]);
				if (sent.error !== null) return sent;
				if (sent.data === 'stale') return moved();
				if ('refused' in sent.data)
					return ClientError.Unavailable({ cause: sent.data.reason });
				return Ok(null);
			}
			let file: FileWrite;
			if (storedWithLfs(path)) {
				const uploaded = await wire.upload([bytes]);
				if (uploaded.error !== null) return uploaded;
				const [lfs] = uploaded.data;
				if (lfs === undefined) throw new Error('one object for one file');
				file = { path, lfs, base: expect };
			} else file = { path, text: decoder.decode(bytes), base: expect };
			const sent = await send([file]);
			if (sent.error !== null) return sent;
			if (sent.data === 'stale') return moved();
			// A store write has no refusal: the folder keeps it, saying why.
			if ('refused' in sent.data)
				return ClientError.Unavailable({ cause: sent.data.reason });
			const landed = sent.data.blobs[path] as BlobId | null | undefined;
			if (landed === null || landed === undefined)
				return refused({
					status: 200,
					code: 'no_blob',
					message: `the write of ${path} landed no file there`,
				});
			return Ok(landed);
		},
		async changes(since) {
			return wire.changes(since ?? undefined);
		},
		async snapshot() {
			const listed = await wire.list(['']);
			if (listed.error !== null) return listed;
			return Ok({
				commit: listed.data.commit,
				files: listed.data.files.map(({ path, blob, lfs }) => ({
					path,
					version: blob,
					size: lfs?.size ?? null,
				})),
			});
		},
		readAt(paths, commit, { attachments }) {
			return readFiles(paths, commit, attachments);
		},
		async writeAll(writes) {
			const attachments = writes.filter(
				(write): write is BatchWrite & { bytes: Uint8Array } =>
					write.bytes !== null && storedWithLfs(write.path),
			);
			const uploaded = await wire.upload(attachments.map(({ bytes }) => bytes));
			if (uploaded.error !== null) return uploaded;
			const objects = new Map(
				attachments.map(({ path }, index) => [path, uploaded.data[index]]),
			);
			const files: FileWrite[] = [];
			for (const { path, bytes, expect: base } of writes) {
				const lfs = objects.get(path);
				if (bytes === null) {
					// Removing nothing where nothing is lands as nothing.
					if (base !== null) files.push({ path, delete: true, base });
				} else if (lfs !== undefined) files.push({ path, lfs, base });
				else files.push({ path, text: decoder.decode(bytes), base });
			}
			if (files.length === 0)
				return refused({
					status: 200,
					code: 'no_files',
					message: 'a batch write names no file to change',
				});
			const sent = await send(files);
			if (sent.error !== null) return sent;
			if (sent.data === 'stale' || 'refused' in sent.data) return Ok(sent.data);
			return Ok({
				commit: sent.data.commit,
				versions: sent.data.blobs as Record<string, BlobId | null>,
			});
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
