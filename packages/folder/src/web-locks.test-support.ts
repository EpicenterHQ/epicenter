/**
 * Test helper: a Web Locks stand-in for runtimes that have none.
 *
 * It is shared by every tab opened in this process. A plain request waits its
 * turn. A `signal` that aborts while the
 * request still waits rejects and the callback is never called; once granted,
 * the signal changes nothing.
 */
import { afterAll } from 'bun:test';
import { createProcessLocks } from './process-locks.js';

function setNavigator(value: unknown) {
	const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
	Object.defineProperty(globalThis, 'navigator', {
		configurable: true,
		value,
	});
	return () => {
		if (original === undefined)
			delete (globalThis as { navigator?: unknown }).navigator;
		else Object.defineProperty(globalThis, 'navigator', original);
	};
}

/** Install the stand-in as `navigator.locks`. Returns the function that removes it. */
export function installWebLocks(): () => void {
	return setNavigator({ locks: createWebLocks() });
}

/** A stand-in lock manager of its own, shared by whoever is handed it. */
export const createWebLocks = createProcessLocks;

/**
 * Give every test in the calling file `navigator.locks`. A browser folder
 * makes no commit without it.
 */
export function useWebLocks() {
	afterAll(installWebLocks());
}

/** Run `work` in a runtime with no `navigator.locks`, as an insecure page has. */
export async function withoutWebLocks<T>(work: () => Promise<T>): Promise<T> {
	const restore = setNavigator({});
	try {
		return await work();
	} finally {
		restore();
	}
}
