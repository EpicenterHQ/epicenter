/**
 * The one place that decides when a command ends on a stop signal
 * (`SIGTERM`, `SIGINT`, `SIGHUP`), which the desktop shell sends when the
 * page that started the command reloads or its window closes, and when it
 * restarts its sync service. The handler is installed by the first
 * `onStop`, `finishBeforeExit`, or `stopWhenStdinCloses`; until then a stop
 * signal ends the process as it would any program.
 *
 * On a stop signal the process first waits for the work it must not cut
 * off, each piece at most the grace it asked for: a token refresh's keychain
 * write (ADR-0565), `STOP_GRACE_MS`, and a sync round, `ROUND_GRACE_MS`.
 * Work such a piece begins after the signal, such as the refresh a round
 * asks for, is waited for too; a command checks `isStopping` before it
 * begins another piece of its own. Then the command's cleanups run (sync
 * ends every `git` still running, ADR-0559), and the process exits
 * `128 + n`.
 *
 * A command the desktop starts for the app's whole life cannot rely on a
 * signal: an app that crashes or is killed sends none. Such a command calls
 * `stopWhenStdinCloses`, and the shell holds the other end of stdin without
 * writing to it; the system closes that end however the app ends, and the
 * command stops as on `SIGHUP`.
 *
 * The graces are coupled to the shell's `STOP_GRACE`
 * (`apps/epicenter/src-tauri/src/cli.rs`), which kills the process group
 * only after waiting longer than the longest of them.
 */

const STOP_SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as const;

/**
 * How long a stop signal waits for a piece of unfinished work that asks for
 * no other grace.
 */
export const STOP_GRACE_MS = 2_000;

/**
 * How long a stop signal waits for a sync round already running. A round
 * cut off in its merge leaves Git's index lock and the merge driver's
 * scratch files behind, or a merge in progress, and every later round stops
 * on them until a person clears them.
 */
export const ROUND_GRACE_MS = 60_000;

const cleanups = new Set<() => void>();
/** Each piece of unfinished work, with the grace it asked for. */
const unfinished = new Map<Promise<void>, number>();

/**
 * Run `cleanup` when a stop signal ends this process, once the unfinished
 * work has finished or run out of time.
 */
export function onStop(cleanup: () => void) {
	cleanups.add(cleanup);
	exitOnStop();
}

/**
 * Run `work` so that a stop signal waits for it to finish, at most `graceMs`
 * after the signal, before the process exits.
 */
export async function finishBeforeExit<T>(
	work: () => Promise<T>,
	graceMs: number = STOP_GRACE_MS,
): Promise<T> {
	const done = Promise.withResolvers<void>();
	unfinished.set(done.promise, graceMs);
	exitOnStop();
	try {
		return await work();
	} finally {
		done.resolve();
		unfinished.delete(done.promise);
	}
}

/**
 * Stop as on `SIGHUP` (exit 129) once stdin ends: the lifeline of a command
 * whose starter holds stdin open, unwritten, for as long as it lives.
 */
export function stopWhenStdinCloses() {
	exitOnStop();
	process.stdin.on('data', () => {});
	process.stdin.once('end', () => stop(STOP_SIGNALS.SIGHUP));
	process.stdin.once('error', () => stop(STOP_SIGNALS.SIGHUP));
}

let installed = false;
let stopping = false;

/** Whether this process was told to stop, so begins no more work. */
export function isStopping() {
	return stopping;
}

/**
 * Resolves when no unfinished work remains, work begun after the stop
 * included, or once the longest grace the work still running asked for has
 * passed since `stoppedAt`.
 */
async function unfinishedSettled(stoppedAt: number): Promise<void> {
	while (unfinished.size > 0) {
		const left = stoppedAt + Math.max(...unfinished.values()) - Date.now();
		if (left <= 0) return;
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			...unfinished.keys(),
			new Promise((done) => {
				timer = setTimeout(done, left);
			}),
		]);
		clearTimeout(timer);
	}
}

/** Handle every stop signal for the rest of this process, once. */
function exitOnStop() {
	if (installed) return;
	installed = true;
	for (const [signal, number] of Object.entries(STOP_SIGNALS))
		process.on(signal, () => stop(number));
}

/** Wait for unfinished work, run every cleanup, and exit `128 + number`. */
function stop(number: number) {
	if (stopping) return;
	stopping = true;
	void unfinishedSettled(Date.now()).then(() => {
		for (const cleanup of cleanups)
			try {
				cleanup();
			} catch {
				// One cleanup that fails must not keep the others from running.
			}
		process.exit(128 + number);
	});
}
