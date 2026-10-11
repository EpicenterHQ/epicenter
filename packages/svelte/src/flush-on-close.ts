/**
 * Flush on close: when the page is about to end, give saves already in flight
 * a bounded moment to land, then let it end.
 *
 * Closing never asks. A draft whose save failed is not held back: the save
 * bar already said so when it failed. What is protected is a save in flight:
 * an autosave's held snapshot and the work admitted before the close. The
 * page's `flush` waits for those (`admissions.quiet()`, each open session's
 * `settled()`); this module bounds the wait so a hung save cannot hold the
 * close open.
 *
 * A desktop host sends one close signal and waits for one acknowledgement or
 * its own timeout, about a second. The page's budget is shorter than the
 * host's, so its acknowledgement normally arrives before the host gives up.
 * In a browser, `pagehide` starts the same flush; the page cannot wait for it.
 */
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/flush-on-close');

/** How long a page waits for its saves on close. The host waits about 1 second. */
export const CLOSE_FLUSH_MS = 800;

/** How a bounded flush ended. */
export type FlushOutcome = 'flushed' | 'timed-out' | 'failed';

/**
 * Run `flush` and wait for it at most `ms`. Never throws: a flush that fails
 * or outlasts the bound still lets the close go on.
 */
export async function flushWithin(
	flush: () => Promise<unknown>,
	ms: number = CLOSE_FLUSH_MS,
): Promise<FlushOutcome> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timedOut = new Promise<FlushOutcome>((resolve) => {
		timer = setTimeout(() => resolve('timed-out'), ms);
	});
	const flushed = (async (): Promise<FlushOutcome> => {
		try {
			await flush();
			return 'flushed';
		} catch (cause) {
			log.warn(new Error('Flushing on close failed.', { cause }));
			return 'failed';
		}
	})();
	try {
		const outcome = await Promise.race([flushed, timedOut]);
		if (outcome === 'timed-out')
			log.warn(new Error(`Saves were still running ${ms} ms after a close.`));
		return outcome;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * A host's close signal for this page. `respond` runs the bounded flush; the
 * binding acknowledges the host once it resolves. Returns how to stop
 * listening, or a promise of it while registration is under way.
 */
export type HostCloseSignal = (
	respond: () => Promise<FlushOutcome>,
) => (() => void) | Promise<() => void>;

/**
 * Flush on the host's close signal, if there is one, and on `pagehide`.
 * Returns how to stop both. Call it once the page's owner exists; a close
 * before that has nothing in flight to wait for.
 */
export function flushOnClose(
	flush: () => Promise<unknown>,
	{
		hostClose,
		ms = CLOSE_FLUSH_MS,
	}: { hostClose?: HostCloseSignal; ms?: number } = {},
): () => void {
	let stopped = false;
	const respond = () => flushWithin(flush, ms);
	const onPageHide = () => void respond();
	globalThis.addEventListener?.('pagehide', onPageHide);

	let stopHost: (() => void) | undefined;
	if (hostClose !== undefined) {
		Promise.resolve()
			.then(() => hostClose(respond))
			.then(
				(stop) => {
					if (stopped) stop();
					else stopHost = stop;
				},
				(cause: unknown) => {
					log.warn(
						new Error('Listening for the host close signal failed.', { cause }),
					);
				},
			);
	}

	return () => {
		if (stopped) return;
		stopped = true;
		globalThis.removeEventListener?.('pagehide', onPageHide);
		stopHost?.();
	};
}
