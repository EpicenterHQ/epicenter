/**
 * A device store over a repository on the server, so the one typed client
 * (`createDeviceClient`) reads and writes it as it does a device's files. A
 * version is the Git blob id on `main` (for a file kept with Git LFS, the
 * blob of its pointer), and so is a stamp: either changes whenever the
 * bytes do, and a listing knows both without reading a file.
 *
 * A note travels as text; any other file's bytes travel as a Git LFS object,
 * uploaded before the write names it and downloaded when the file is read.
 *
 * A write lands only while the path holds what its writer expects: it
 * carries that as its `base` (null for `'absent'`), which the server checks
 * in the step that moves `main`, and a refusal (`occupied` or `stale`) is
 * `'stale'` here. The server never merges (ADR-0773).
 *
 * Listeners hear, while any listens, every move of `main`: one poller per
 * store reads `main` every `POLL_MS` and stops with the last listener or the
 * account. The server becoming unreachable, or reachable again, is a change
 * too: what a reader can show changed with it.
 */

import { ClientError, storedWithLfs } from '@epicenter/definition/contract';
import { isNamespaceId, isRepositoryName } from '@epicenter/definition/site';
import { Ok } from 'wellcrafted/result';
import { createChanges } from '../changes.js';
import type { DeviceStore, Version } from '../device/store.js';
import {
	createWire,
	type FileWrite,
	type RemoteAccount,
	RemoteError,
	type Wire,
	type WriteAnswer,
} from './wire.js';

/** How often a store with listeners reads `main` to hear that it moved. */
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
 * `account` reaches it. A `repository` that names none throws.
 */
export function repositoryStore(
	account: RemoteAccount,
	repository: string,
): DeviceStore {
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

	/** One file's write: the answer, `'stale'` for a refusal of its expectation. */
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
		async list(under = '') {
			const listed = await wire.list(under);
			if (listed.error !== null) return listed;
			return Ok(
				listed.data.map(({ path, blob }) => ({
					path,
					stamp: blob,
					version: blob,
				})),
			);
		},
		async read(path) {
			const read = await wire.read(path);
			if (read.error !== null) return read;
			if (read.data === null) return Ok(null);
			const { blob, text, lfs } = read.data;
			if (typeof text === 'string')
				return Ok({ bytes: encoder.encode(text), version: blob, stamp: blob });
			if (!lfs)
				return refused({
					status: 200,
					code: 'not_lfs',
					message: `${path} is not a Git LFS pointer on main`,
				});
			const bytes = await wire.download(lfs);
			if (bytes.error !== null) return bytes;
			return Ok({ bytes: bytes.data, version: blob, stamp: blob });
		},
		async write(path, bytes, expected) {
			if (bytes === null) {
				// Removing nothing where nothing is lands, as on a device.
				if (expected === 'absent') {
					const there = await wire.read(path);
					if (there.error !== null) return there;
					return Ok(there.data === null ? { landed: null } : 'stale');
				}
				const sent = await send({ path, delete: true, base: expected.version });
				if (sent.error !== null) return sent;
				return Ok(sent.data === 'stale' ? sent.data : { landed: null });
			}
			const base: Version | null =
				expected === 'absent' ? null : expected.version;
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
			return Ok({ landed });
		},
		watch: pollMain(account, wire).watch,
	};
}

/**
 * Listeners of every move of `main` while any listens: a poll of `main`
 * every `POLL_MS`, which cannot say what moved (null).
 */
function pollMain(account: RemoteAccount, wire: Wire) {
	/** The commit `main` was at when last read; undefined before the first read. */
	let seen: string | null | undefined;
	let reachable = true;
	return createChanges((emit) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		let stopped = false;
		async function poll() {
			if (stopped || account.signal.aborted) return;
			const head = await wire.head();
			if (stopped) return;
			if (head.error === null) {
				if (!reachable || (seen !== undefined && head.data !== seen))
					emit(null);
				seen = head.data;
				reachable = true;
			} else if (reachable) {
				reachable = false;
				emit(null);
			}
			timer = setTimeout(poll, POLL_MS);
		}
		void poll();
		return () => {
			stopped = true;
			clearTimeout(timer);
		};
	});
}
