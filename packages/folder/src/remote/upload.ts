/**
 * Automatic upload (decision 12): a device's captures go to the repository
 * once its person is signed in and online, a create on the server and then
 * a delete on the device.
 *
 * One run drains the device's outbox, oldest capture first. For each:
 *
 * 1. its files' bytes go up as Git LFS objects (batch, then PUT), notes
 *    as text;
 * 2. one write lands them, as creates (or, for an edit kept from an earlier
 *    capture, updates over the blob that landed);
 * 3. the server's reply is recorded in the capture's sidecar
 *    (`acknowledge`), with the version of each file sent;
 * 4. the device deletes each file only at the version it sent (`finish`),
 *    so an edit made since stays, and goes up as a new capture (a delete
 *    made since goes up as one too); a file other than a note moves to the
 *    device's cache (`cacheOf`) as it goes.
 *
 * Each step is safe to repeat, so a crash anywhere resumes: after the PUT
 * the batch skips the stored object; after a write whose reply was lost the
 * same write goes again, and the server judges it like any write (decision
 * 68): bytes already there land as nothing, and bytes edited since merge
 * as two creates, at most one conflict block, nothing lost; after the
 * acknowledgement only the delete remains.
 *
 * The first run also adopts the device's files that no capture names (a
 * crash between `create` and the outbox's `add`), one capture per file.
 * A capture that names a path the contract does not claim, or that the
 * server refuses, stays on the device and is reported, never sent again
 * until something changes.
 *
 * Runs are single flight: one at a time in a page, and across a browser's
 * tabs one at a time through a Web Lock. A run starts when uploading starts,
 * when the browser comes back online, after each new capture, and again
 * after a failure, waiting longer each time. Uploading stops for good when
 * the account is retired (sign-out or another person signing in), so one
 * person's credential never uploads after another's arrives; the files that
 * account's uploads cached on the device go with it, once a run in flight
 * ends.
 */

import type { Client } from '@epicenter/definition/contract';
import {
	ClientError,
	type Contract,
	storedWithLfs,
	type Version,
} from '@epicenter/definition/contract';
import { timeId } from '@epicenter/definition/ids';
import {
	defineErrors,
	type InferError,
	type InferErrors,
} from 'wellcrafted/error';
import { createLogger, type Logger } from 'wellcrafted/logger';
import { Ok, type Result } from 'wellcrafted/result';
import { type Capture, deviceParts } from '../device/outbox.js';
import { decodeNote } from '../note-codec.js';
import { remoteParts } from './client.js';
import type { FileWrite } from './wire.js';

type Unavailable = InferError<typeof ClientError.Unavailable>;

/** Why a capture stays on the device instead of going up. */
export const UploadRefusal = defineErrors({
	/** The capture names a path the contract does not claim. */
	OutsideContract: ({ id, path }: { id: string; path: string }) => ({
		message: `The capture ${id} names ${path}, which the contract does not claim`,
		id,
		path,
	}),
	/** A note of the capture is not UTF-8 text. */
	NotText: ({ id, path }: { id: string; path: string }) => ({
		message: `The note ${path} of capture ${id} is not UTF-8 text`,
		id,
		path,
	}),
	/** The server refused the capture's write as it is. */
	Refused: ({
		id,
		status,
		code,
		reason,
	}: {
		id: string;
		status: number;
		code: string | null;
		reason: string;
	}) => ({
		message: `The server refused capture ${id} (${status}${code ? ` ${code}` : ''}): ${reason}`,
		id,
		status,
		code,
	}),
});
export type UploadRefusal = InferErrors<typeof UploadRefusal>;

/** What one run did. */
export type UploadReport = {
	/** The captures the server acknowledged and the device let go of. */
	uploaded: string[];
	/** The captures left on the device because they cannot go up as they are. */
	refused: UploadRefusal[];
	/**
	 * Why the run stopped before the end, leaving the rest for a later run;
	 * null when it reached the end.
	 */
	interrupted: Unavailable | null;
};

export type Uploader = {
	/**
	 * Run now, after the run in progress if there is one, and answer what
	 * the run did. Runs also start on their own; this is for a caller that
	 * wants to wait for one, or knows something changed (a sign-in renewed).
	 */
	drain(): Promise<UploadReport>;
	/** Stop: no further runs, and every listener and timer released. */
	[Symbol.dispose](): void;
};

/** The Web Lock every tab's uploader takes, so one tab drains the outbox at a time. */
export const UPLOAD_LOCK = 'epicenter-upload';

/** How long to wait before running again after the nth failure in a row. */
const RETRY_MS = [5_000, 30_000, 120_000, 300_000] as const;

const UploadDiagnostic = defineErrors({
	CaptureLeft: ({ cause }: { cause: unknown }) => ({
		message: 'A capture stays on the device',
		cause,
	}),
	RunInterrupted: ({ cause }: { cause: unknown }) => ({
		message: 'An upload run stopped early; it runs again later',
		cause,
	}),
	CacheLeft: ({ cause }: { cause: unknown }) => ({
		message: "A retired account's cached files stay on the device",
		cause,
	}),
});

/**
 * Start uploading `device`'s captures to the repository `remote` reaches.
 * Both must be clients of the same contract.
 *
 * @example
 * ```ts
 * const device = openDevice(recorder);
 * const remote = openRemote(recorder, { account });
 * using uploader = startUploading(device, remote);
 * const report = await uploader.drain();
 * ```
 */
export function startUploading<TContract extends Contract>(
	device: Client<TContract>,
	remote: Client<TContract>,
	{ log = createLogger('folder/upload') }: { log?: Logger } = {},
): Uploader {
	const { compiled, store, outbox, cache, onCapture } = deviceParts(device);
	const { account, wire, compiled: remoteContract } = remoteParts(remote);
	if (compiled.name !== remoteContract.name)
		throw new Error(
			`The device holds ${compiled.name} and the remote ${remoteContract.name}`,
		);

	let stopped = false;
	let adopted = false;
	let failures = 0;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let running: Promise<UploadReport> | null = null;
	let queued: Promise<UploadReport> | null = null;

	const retired = () =>
		ClientError.Unavailable({
			cause: account.signal.reason ?? 'uploading stopped',
		}).error;

	/** Name every claimed device file no capture names in a capture of its own. */
	async function adopt(): Promise<Result<void, Unavailable>> {
		const listed = await store.list();
		if (listed.error !== null) return listed;
		const captures = await outbox.list();
		if (captures.error !== null) return captures;
		const named = new Set(
			captures.data.items.flatMap((capture) => Object.keys(capture.paths)),
		);
		const paths = listed.data.map(({ path }) => path).sort();
		for (const path of paths) {
			if (named.has(path)) continue;
			const claim = compiled.claim(path);
			if (claim === null) continue;
			const read = await store.read(path);
			if (read.error !== null) return read;
			if (read.data === null) continue;
			const added = await outbox.add({
				id: timeId(),
				files: [
					{
						collection: claim.collection.name,
						...claim.params,
						version: read.data.version,
					},
				],
			});
			if (added.error?.name === 'Unavailable')
				return { data: null, error: added.error };
			// Changed or taken since it was read: the next run looks again.
			if (added.error !== null)
				log.warn(UploadDiagnostic.CaptureLeft({ cause: added.error }));
		}
		return Ok(undefined);
	}

	/** Send `capture` and record the server's reply; `refused` when it cannot go as it is. */
	async function send(
		capture: Capture,
	): Promise<
		Result<'sent' | 'gone' | { refused: UploadRefusal }, Unavailable>
	> {
		const { id } = capture;
		const files: (
			| FileWrite
			| { path: string; bytes: Uint8Array; base?: Version }
		)[] = [];
		/** The version of each file sent: only these may be let go. */
		const sent: Record<string, Version> = {};
		for (const path of Object.keys(capture.paths)) {
			if (compiled.claim(path) === null)
				return Ok({
					refused: UploadRefusal.OutsideContract({ id, path }).error,
				});
			const read = await store.read(path);
			if (read.error !== null) return read;
			const base = capture.bases[path] as Version | undefined;
			if (read.data === null) {
				// Deleted on the device: nothing to send for a file new to the
				// server, and a delete of what it holds for one it has.
				if (base !== undefined) files.push({ path, delete: true, base });
				continue;
			}
			sent[path] = read.data.version;
			if (storedWithLfs(path)) {
				files.push({ path, bytes: read.data.bytes, base });
				continue;
			}
			const text = decodeNote(read.data.bytes);
			if (text.error !== null)
				return Ok({ refused: UploadRefusal.NotText({ id, path }).error });
			files.push({ path, text: text.data, base });
		}
		if (files.length === 0) return Ok('gone');
		const binaries = files.filter((file) => 'bytes' in file);
		const uploaded = await wire.upload(binaries.map(({ bytes }) => bytes));
		if (uploaded.error !== null) return uploaded;
		const objects = new Map(
			binaries.map(({ path }, index) => [path, uploaded.data[index]]),
		);
		const written = await wire.write({
			files: files.map((file) => {
				const lfs = objects.get(file.path);
				return lfs
					? { path: file.path, lfs, base: file.base }
					: (file as FileWrite);
			}),
		});
		if (written.error !== null) return written;
		const answer = written.data;
		if (!answer.landed) {
			const refusal = UploadRefusal.Refused({
				id,
				status: answer.status,
				code: answer.code,
				reason: answer.message,
			}).error;
			// An object the server has not verified is worth another try.
			if (answer.code === 'lfs_not_uploaded')
				return ClientError.Unavailable({ cause: refusal });
			return Ok({ refused: refusal });
		}
		const { commit, paths, blobs } = answer.receipt;
		const acknowledged = await outbox.acknowledge(
			id,
			{
				commit,
				paths,
				blobs: Object.fromEntries(
					Object.entries(blobs).filter(
						(entry): entry is [string, string] => entry[1] !== null,
					),
				),
			},
			sent,
		);
		if (acknowledged.error?.name === 'Unavailable')
			return { data: null, error: acknowledged.error };
		if (acknowledged.error !== null)
			log.warn(UploadDiagnostic.CaptureLeft({ cause: acknowledged.error }));
		return Ok('sent');
	}

	/** Let go of an acknowledged (or emptied) capture's files on the device. */
	async function finish(id: string): Promise<Result<boolean, Unavailable>> {
		const finished = await outbox.finish(id);
		if (finished.error?.name === 'Unavailable')
			return { data: null, error: finished.error };
		if (finished.error !== null) {
			log.warn(UploadDiagnostic.CaptureLeft({ cause: finished.error }));
			return Ok(false);
		}
		return Ok(true);
	}

	/** One pass over the outbox. */
	async function pass(
		report: UploadReport,
	): Promise<Result<void, Unavailable>> {
		if (!adopted) {
			const orphans = await adopt();
			if (orphans.error !== null) return orphans;
			adopted = true;
		}
		// Again until a listing holds nothing new: finishing a capture can
		// queue its kept edits as another.
		const seen = new Set<string>();
		for (;;) {
			const listed = await outbox.list();
			if (listed.error !== null) return listed;
			const fresh = listed.data.items.filter(({ id }) => !seen.has(id));
			if (fresh.length === 0) return Ok(undefined);
			for (const capture of fresh) {
				seen.add(capture.id);
				if (stopped) return { data: null, error: retired() };
				if (capture.state === 'pending') {
					const sent = await send(capture);
					if (sent.error !== null) return sent;
					if (typeof sent.data === 'object') {
						report.refused.push(sent.data.refused);
						continue;
					}
				}
				const finished = await finish(capture.id);
				if (finished.error !== null) return finished;
				if (finished.data) report.uploaded.push(capture.id);
			}
		}
	}

	async function run(): Promise<UploadReport> {
		const report: UploadReport = {
			uploaded: [],
			refused: [],
			interrupted: null,
		};
		if (stopped) return { ...report, interrupted: retired() };
		const locks = globalThis.navigator?.locks;
		// A throw is a bug, but the runs started on their own have no caller
		// to throw to: it interrupts the run like any other failure.
		const guarded = () =>
			pass(report).catch((cause: unknown) =>
				ClientError.Unavailable({ cause }),
			);
		const result = locks
			? await locks.request(UPLOAD_LOCK, guarded)
			: await guarded();
		report.interrupted = result.error;
		if (result.error === null) failures = 0;
		else if (!stopped) {
			log.warn(UploadDiagnostic.RunInterrupted({ cause: result.error }));
			const wait = RETRY_MS[Math.min(failures, RETRY_MS.length - 1)];
			failures++;
			clearTimeout(retry);
			retry = setTimeout(() => void drain(), wait);
			(retry as { unref?: () => void }).unref?.();
		}
		return report;
	}

	function drain(): Promise<UploadReport> {
		if (running === null) {
			running = run().finally(() => {
				running = null;
			});
			return running;
		}
		// One more run after this one covers every caller that asks meanwhile,
		// and answers what both runs did.
		queued ??= running.then(async (earlier) => {
			queued = null;
			const later = await drain();
			return {
				uploaded: [...earlier.uploaded, ...later.uploaded],
				refused: later.refused,
				interrupted: later.interrupted,
			};
		});
		return queued;
	}

	const wake = () => void drain();
	const unsubscribe = onCapture(wake);
	globalThis.addEventListener?.('online', wake);

	function stop() {
		if (stopped) return;
		stopped = true;
		clearTimeout(retry);
		unsubscribe();
		globalThis.removeEventListener?.('online', wake);
		account.signal.removeEventListener('abort', retire);
	}

	/** The account is gone: stop, and drop what its uploads cached. */
	function retire() {
		stop();
		void (queued ?? running ?? Promise.resolve()).then(async () => {
			const cleared = await cache.clear();
			if (cleared.error !== null)
				log.warn(UploadDiagnostic.CacheLeft({ cause: cleared.error }));
		});
	}

	if (account.signal.aborted) retire();
	else {
		account.signal.addEventListener('abort', retire, { once: true });
		wake();
	}

	return { drain, [Symbol.dispose]: stop };
}
