/**
 * The kernel's `flock`, the one lock `epicenter` takes (ADR-0850). A lock
 * belongs to an open descriptor: it is released when that descriptor closes,
 * here or when the process holding it dies, so a crash never leaves it held.
 * Two descriptors conflict even within one process, so `serve`'s calls and
 * its clock exclude each other as two processes would. Bun opens every
 * descriptor close-on-exec, so no child (Git, an action's own process) keeps
 * a lock after its holder lets go.
 */

import { dlopen, FFIType } from 'bun:ffi';
import { closeSync, openSync } from 'node:fs';

/** Shared: any number of holders at once. Exclusive: one holder, and no shared one. */
export type LockMode = 'shared' | 'exclusive';

const LOCK_SH = 1;
const LOCK_EX = 2;
const LOCK_NB = 4;

/** How long a wait for a lock sleeps between tries. */
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

const operation = (mode: LockMode) => (mode === 'shared' ? LOCK_SH : LOCK_EX);

/**
 * Lock `fd`, open on `path`, blocking this whole process until no other
 * holder conflicts. Only for a process that runs one thing at a time, such as
 * an action's child; `serve` waits with `hold` instead.
 */
export function lockBlocking(fd: number, path: string, mode: LockMode) {
	if (flockOf()(fd, operation(mode)) !== 0)
		throw new Error(`Could not lock ${path}`);
}

/** A lock this process holds; `release` closes its descriptor, which releases it. */
export type Held = { release(): void };

/**
 * Hold the lock on the file at `path`, made when missing, trying again every
 * 20 ms for up to `waitMs` (0 tries once) without ever blocking this
 * process's event loop. `undefined` when another holder kept it that long.
 */
export async function hold(
	path: string,
	mode: LockMode,
	waitMs: number,
): Promise<Held | undefined> {
	const fd = openSync(path, 'a');
	const deadline = Date.now() + waitMs;
	let held = false;
	try {
		for (;;) {
			if (flockOf()(fd, operation(mode) | LOCK_NB) === 0) {
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
