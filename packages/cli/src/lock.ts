/**
 * An app's lock, the one lock `epicenter` takes (ADR-0850): the kernel's
 * `flock` on the app's folder itself, so there is no lock file to make,
 * leave, or clean up. One holder at a time: a call from its first write until
 * its commit has finished (`run.ts`), and a snapshot with no call while it
 * commits (`snapshot.ts`). A lock belongs to an open descriptor: it is
 * released when that descriptor closes, here or when the process holding it
 * dies, so a crash never leaves it held. Two descriptors conflict even within
 * one process, so `serve`'s clock and a call it relays exclude each other as
 * two processes would. Bun opens every descriptor close-on-exec, so no child
 * (Git, an action's own process) keeps the lock after its holder lets go.
 */

import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';

/** How long a write or a snapshot waits for the app's lock before it gives up. */
export const LOCK_WAIT_MS = 30_000;

const LOCK_EX = 2;
const LOCK_NB = 4;

/** How long a wait for the lock sleeps between tries. */
const RETRY_MS = 20;

/** The C library's `flock`, opened on first use. */
let flock: ((fd: number, operation: number) => number) | undefined;
function flockOf() {
	if (flock) return flock;
	const libc =
		process.platform === 'darwin'
			? 'libc.dylib'
			: process.platform === 'linux'
				? 'libc.so.6'
				: undefined;
	if (!libc)
		throw new Error(
			`epicenter needs flock, which ${process.platform} does not have`,
		);
	const { symbols } = dlopen(libc, {
		flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 },
	});
	flock = (fd, operation) => symbols.flock(fd, operation);
	return flock;
}

/** The app's lock, held; `release` closes its descriptor, which releases it. */
export type Held = { release(): void };

/**
 * Hold the lock on the app folder `dir`, trying again every 20 ms for up to
 * `waitMs` (0 tries once) without ever blocking this process's event loop.
 * `undefined` when another holder kept it that long.
 */
export async function hold(
	dir: string,
	waitMs: number,
): Promise<Held | undefined> {
	const fd = openSync(dir, 'r');
	const deadline = Date.now() + waitMs;
	let held = false;
	try {
		for (;;) {
			if (flockOf()(fd, LOCK_EX | LOCK_NB) === 0) {
				held = true;
				return { release: () => closeSync(fd) };
			}
			if (Date.now() >= deadline) return undefined;
			await Bun.sleep(RETRY_MS);
		}
	} finally {
		if (!held) closeSync(fd);
	}
}
