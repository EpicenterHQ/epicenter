/**
 * The one place that decides when a command ends on a stop signal
 * (`SIGTERM`, `SIGINT`, `SIGHUP`), which a terminal, an agent, or the
 * system sends. The handler is installed by the first `finishBeforeExit`;
 * until then a stop signal ends the process as it would any program.
 *
 * On a stop signal the process first waits for the work it must not cut
 * off, each piece at most the grace it asked for: a token refresh's keychain
 * write (ADR-0565), `STOP_GRACE_MS`. Work such a piece begins after the
 * signal is waited for too. Then the process exits `128 + n`. A sync needs
 * no grace: one stopped anywhere converges when it runs again.
 */

const STOP_SIGNALS = { SIGTERM: 15, SIGINT: 2, SIGHUP: 1 } as const;

/**
 * How long a stop signal waits for a piece of unfinished work that asks for
 * no other grace.
 */
export const STOP_GRACE_MS = 2_000;

/** Each piece of unfinished work, with the grace it asked for. */
const unfinished = new Map<Promise<void>, number>();

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

let installed = false;
let stopping = false;

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

/** Wait for unfinished work, then exit `128 + number`. */
function stop(number: number) {
	if (stopping) return;
	stopping = true;
	void unfinishedSettled(Date.now()).then(() => process.exit(128 + number));
}
