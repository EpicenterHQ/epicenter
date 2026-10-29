/**
 * The upload track: the bytes a replica owes its server (pointers it made
 * whose bytes the server does not hold yet), sent through the Git LFS
 * batch API beside the numbered commit flow, never inside it. Host-free:
 * the device's `BlobStore`, the replica's owed query and an `LfsClient` are
 * given.
 *
 * One loop, a few objects in parallel, each once: owed oids are asked for
 * in one batch; bytes the server already holds are marked present; an
 * upload action PUTs the object read from this device's store (a `File` in
 * the browser, so its length is known and nothing is copied), then posts
 * `verify` if the answer gives one, then marks it present; a per-object
 * refusal marks it refused with the server's reason; bytes on neither this
 * device nor the server are refused too. Network failures, 5xx and 429 wait
 * and go again, doubling from `retry` up to `RETRY_CAP`. The loop follows
 * whatever `href` an answer gives, so a server that presigns direct uploads
 * needs nothing here.
 *
 * It starts when made (a worker starting), on `kick` (a socket attaching,
 * a pointer saved: the host calls it on every change), and after a failure
 * once its wait is over. A loop cut off (a tab closed mid-PUT) leaves the
 * bytes owed, so the next one starts again from the sealed bytes: the
 * server stores nothing for a PUT that did not finish.
 */
import type { Logger } from 'wellcrafted/logger';
import { defineErrors } from 'wellcrafted/error';
import type { LfsClient, LfsClientError } from '../wire/client.js';
import type { BlobStore } from './blobs.js';
import type { Replica } from './replica.js';

/** Why the server refused bytes, by the batch API's per-object code. */
export const UPLOAD_REFUSALS = {
	422: 'the file is larger than this repository allows',
	507: 'the repository has no room left for files',
	missing: 'these bytes are not on this device or the server',
} as const;

/** A person's reason for a refusal the server gave as `code`: its batch code, or a PUT's status (413 past the blob limit). */
const refusal = (code: number, message: string) => (code === 422 || code === 413 ? UPLOAD_REFUSALS[422] : code === 507 ? UPLOAD_REFUSALS[507] : message);

/** Objects asked for in one batch, and sent at once. */
const PARALLEL = 4;
/** The longest wait between attempts after a failure, in ms. */
export const RETRY_CAP = 30_000;

const UploadDiagnostic = defineErrors({
	Failed: ({ oid, cause }: { oid: string; cause: LfsClientError }) => ({ message: `An upload of ${oid} failed and will go again: ${cause.message}`, oid, cause }),
});

export function startUploads({
	replica,
	store,
	lfs,
	after = (ms, run) => void setTimeout(run, ms),
	retry = 1_000,
	log,
}: {
	replica: Pick<Replica, 'owed' | 'present' | 'refused'>;
	store: BlobStore<Blob>;
	lfs: LfsClient;
	/** The host's timer. */
	after?: (ms: number, run: () => void) => void;
	/** The first wait after a failure, in ms. */
	retry?: number;
	log?: Logger;
}) {
	/** Oids being sent now: each goes once. */
	const sending = new Set<string>();
	let stopped = false;
	let wait = retry;
	let waiting = false;
	/** The loop running, so a test or a host can wait for the track to be idle. */
	let running: Promise<void> = Promise.resolve();

	function failed(oid: string, cause: LfsClientError) {
		log?.warn(UploadDiagnostic.Failed({ oid, cause }));
		if (waiting || stopped) return;
		waiting = true;
		after(wait, () => {
			waiting = false;
			kick();
		});
		wait = Math.min(wait * 2, RETRY_CAP);
	}

	async function send(object: { oid: string; size: number }) {
		const asked = await lfs.batch('upload', [object]);
		if (asked.error !== null) return failed(object.oid, asked.error);
		const answer = asked.data.find((each) => each.oid === object.oid);
		if (answer?.error !== undefined) return replica.refused(object.oid, refusal(answer.error.code, answer.error.message));
		const upload = answer?.actions?.upload;
		if (upload !== undefined) {
			const bytes = await store.read(object.oid);
			if (bytes === null) return replica.refused(object.oid, UPLOAD_REFUSALS.missing);
			const put = await lfs.put(upload, bytes);
			if (put.error !== null) return put.error.name === 'Refused' ? replica.refused(object.oid, refusal(put.error.status, put.error.message)) : failed(object.oid, put.error);
			const verify = answer?.actions?.verify;
			if (verify !== undefined) {
				const verified = await lfs.verify(verify, object);
				if (verified.error !== null) return failed(object.oid, verified.error);
			}
		}
		wait = retry;
		replica.present(object.oid, object.size);
	}

	async function loop() {
		for (;;) {
			if (stopped || waiting) return;
			const room = PARALLEL - sending.size;
			if (room <= 0) return;
			const next = replica.owed(PARALLEL * 2).filter(({ oid }) => !sending.has(oid)).slice(0, room);
			if (next.length === 0) return;
			await Promise.all(
				next.map(async (object) => {
					sending.add(object.oid);
					try {
						await send(object);
					} finally {
						sending.delete(object.oid);
					}
				}),
			);
		}
	}

	function kick() {
		if (stopped || waiting) return;
		running = running.then(loop, loop);
	}
	kick();

	return {
		/** Look for owed bytes now. */
		kick,
		/** Resolve once the track has nothing to send, or waits after a failure. */
		idle: () => running,
		stop() {
			stopped = true;
		},
	};
}
export type Uploads = ReturnType<typeof startUploads>;
