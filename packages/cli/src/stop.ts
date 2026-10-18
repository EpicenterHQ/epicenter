/**
 * The one place that decides when a command ends on a stop signal
 * (`SIGTERM`, `SIGINT`, `SIGHUP`), which the desktop shell sends when the
 * page that started the command reloads or its window closes. The handler
 * is installed by the first `onStop` or `finishBeforeExit`; until then a
 * stop signal ends the process as it would any program.
 *
 * On a stop signal the command's cleanups run at once (a history command
 * ends every `git` it started, ADR-0559), then the process waits for the
 * work it must not cut off (a token refresh's keychain write, ADR-0565), at
 * most `STOP_GRACE_MS`, and exits `128 + n`.
 *
 * `STOP_GRACE_MS` is coupled to the shell's `STOP_GRACE`
 * (`apps/epicenter/src-tauri/src/cli.rs`), which kills the process group
 * only after waiting longer than this: 3 seconds against 2.
 */

const STOP_SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as const;

/**
 * How long a stop signal waits for unfinished work before the process exits
 * anyway. The desktop shell waits longer before it kills.
 */
export const STOP_GRACE_MS = 2_000;

const cleanups = new Set<() => void>();
const unfinished = new Set<Promise<void>>();

/** Run `cleanup` at once if this process is told to stop. */
export function onStop(cleanup: () => void) {
	cleanups.add(cleanup);
	exitOnStop();
}

/**
 * Run `work` so that a stop signal waits for it to finish, at most
 * `STOP_GRACE_MS`, before the process exits.
 */
export async function finishBeforeExit<T>(work: () => Promise<T>): Promise<T> {
	const done = Promise.withResolvers<void>();
	unfinished.add(done.promise);
	exitOnStop();
	try {
		return await work();
	} finally {
		done.resolve();
		unfinished.delete(done.promise);
	}
}

/** Resolves when no unfinished work remains, or after `graceMs`. */
async function unfinishedSettled(graceMs = STOP_GRACE_MS): Promise<void> {
	if (unfinished.size === 0) return;
	let timer: ReturnType<typeof setTimeout> | undefined;
	await Promise.race([
		Promise.allSettled([...unfinished]),
		new Promise((done) => {
			timer = setTimeout(done, graceMs);
		}),
	]);
	clearTimeout(timer);
}

let installed = false;

/** Handle every stop signal for the rest of this process, once. */
function exitOnStop() {
	if (installed) return;
	installed = true;
	let stopping = false;
	for (const [signal, number] of Object.entries(STOP_SIGNALS))
		process.on(signal, () => {
			if (stopping) return;
			stopping = true;
			for (const cleanup of cleanups)
				try {
					cleanup();
				} catch {
					// One cleanup that fails must not keep the others from running.
				}
			void unfinishedSettled().then(() => process.exit(128 + number));
		});
}
