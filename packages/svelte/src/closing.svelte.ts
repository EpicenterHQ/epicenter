/**
 * Closing a desktop window: the page's close handler, and whether the close
 * is slow enough to show the "Still saving…" notice (`ClosingNotice`).
 *
 * The shell awaits the handler and destroys the window once it returns. The
 * handler awaits the owner's `close`, with no timeout: closing ends when the
 * saves in flight have landed. When that has run longer than `slowAfter`,
 * `slow` turns on, and `closeAnyway` stops waiting and lets the window go.
 * The delay is when the notice shows, not a bound on the close.
 *
 * `confirm`, when given, is asked before the first close starts: answering
 * `false` keeps the window open (`event.preventDefault()`), and nothing has
 * been closed. A second request while it is asked joins the same answer; a
 * request while the close runs joins the close.
 */
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('svelte/closing');

/** How long a close runs before the notice shows. */
export const SLOW_CLOSE_MS = 1_200;

/** What the shell hands the handler: `preventDefault` keeps the window open. */
export type CloseRequest = { preventDefault(): void };

export type Closing = ReturnType<typeof createClosing>;

export function createClosing({
	close,
	confirm,
	slowAfter = SLOW_CLOSE_MS,
}: {
	/** The owner's one ending. A rejection is logged, and the window still goes. */
	close: () => Promise<unknown>;
	/** Asked before the close starts; `false` keeps the window open. */
	confirm?: () => boolean | Promise<boolean>;
	slowAfter?: number;
}) {
	let slow = $state(false);
	let confirming: Promise<boolean> | undefined;
	let closing: Promise<void> | undefined;
	let stopWaiting: (() => void) | undefined;

	function run(): Promise<void> {
		closing ??= new Promise<void>((resolve) => {
			const timer = setTimeout(() => {
				slow = true;
			}, slowAfter);
			const done = () => {
				clearTimeout(timer);
				slow = false;
				resolve();
			};
			stopWaiting = done;
			Promise.resolve()
				.then(close)
				.catch((cause: unknown) => {
					log.warn(new Error('Closing the page failed.', { cause }));
				})
				.finally(done);
		});
		return closing;
	}

	function ask(): Promise<boolean> {
		if (confirm === undefined) return Promise.resolve(true);
		confirming ??= Promise.resolve()
			.then(confirm)
			.catch((cause: unknown) => {
				log.warn(new Error('Asking before closing failed.', { cause }));
				return false;
			})
			.finally(() => {
				confirming = undefined;
			});
		return confirming;
	}

	return {
		/** Whether the close has run longer than `slowAfter` and still runs. */
		get slow() {
			return slow;
		},
		/** The window's close handler. Resolves when the window may go. */
		async request(event: CloseRequest): Promise<void> {
			if (closing === undefined && !(await ask())) {
				event.preventDefault();
				return;
			}
			await run();
		},
		/** Stop waiting for the close and let the window go. */
		closeAnyway() {
			stopWaiting?.();
		},
	};
}
