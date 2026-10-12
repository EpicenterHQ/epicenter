/**
 * The desktop shell's close question, apart from any folder.
 *
 * The question arrives on the Whispering host's event stream, or, when the
 * host is gone, as a page event the shell raises. The answer goes back through
 * the host, or, when it is gone, as a navigation to the quit address. This
 * module reaches only the bridge, so a page whose desktop workspace could not
 * be loaded or opened can still be quit.
 */
import {
	type BridgeConnection,
	createHttpBridge,
	type HttpBridge,
} from '../bridge/http.js';

/** Raised in the page by the shell (`src-tauri/src/lib.rs`) when it cannot ask the host. */
export const CLOSE_BLOCKED_EVENT = 'whispering:close-blocked';
/** The address the shell treats as "quit" once the host is gone. It is never loaded. */
export const QUIT_PATH = '/__whispering__/quit';
const RECONNECT_MS = 500;

const describe = (cause: unknown) =>
	cause instanceof Error ? cause.message : String(cause);

/**
 * Hear the shell's close question on the host's event stream until stopped.
 *
 * One stream at a time, connected again when it drops or cannot be reached.
 * The host repeats a question nobody has answered to every stream that
 * connects, so a dropped stream, or one that connects after the person asked,
 * loses none. Stopping ends the stream and the reconnecting; the returned
 * promise settles when both are over.
 */
export function watchCloseRequests(
	bridge: HttpBridge,
	onRequest: () => void,
): () => Promise<void> {
	const stopping = new AbortController();
	const watching = (async () => {
		while (!stopping.signal.aborted) {
			try {
				await bridge.events((event) => {
					if (!stopping.signal.aborted && event.type === 'close-requested')
						onRequest();
				}, stopping.signal);
			} catch {
				// The host is unreachable for now; the loop tries again.
			}
			if (stopping.signal.aborted) return;
			await new Promise<void>((resolve) => {
				const done = () => {
					clearTimeout(timer);
					stopping.signal.removeEventListener('abort', done);
					resolve();
				};
				const timer = setTimeout(done, RECONNECT_MS);
				stopping.signal.addEventListener('abort', done, { once: true });
			});
		}
	})();
	return () => {
		stopping.abort();
		return watching;
	};
}

/**
 * Let the window close when opening failed and nothing was opened.
 *
 * The shell holds back every close until the page answers, because a page may
 * hold unsaved work. A page whose workspace could not be opened holds none:
 * there is no session, no request, and no write in flight. But it
 * would also have nobody to answer, and the window could never be closed. So
 * once opening has failed, and only then, this answers each close the person
 * asks for: `proceed` through the host, or the quit address when the shell
 * says the host is gone.
 *
 * It answers requests; it never closes anything on its own. It must be
 * stopped before another opening is attempted, so it can never answer for a
 * session that holds work. Returns the function that stops it.
 */
export function answerCloseWithNothingOpen(
	connection: BridgeConnection,
): () => void {
	const bridge = createHttpBridge(connection);
	let stopped = false;
	const stopWatching = watchCloseRequests(bridge, () => {
		// Undeliverable: the window stays, and closing again asks again.
		void bridge.app('close', { decision: 'proceed' }).catch(() => {});
	});
	const quit = () => {
		if (!stopped) window.location.assign(`${connection.origin}${QUIT_PATH}`);
	};
	window.addEventListener(CLOSE_BLOCKED_EVENT, quit);
	return () => {
		stopped = true;
		window.removeEventListener(CLOSE_BLOCKED_EVENT, quit);
		void stopWatching();
	};
}

/**
 * The person's own quit, from a window whose opening failed however it
 * failed. Nothing listens and nothing answers on its own: this runs only when
 * the person presses Quit.
 *
 * It answers `proceed` through the host. When the host does not take it, the
 * page also navigates to the quit address, which the shell honors only once
 * its host is gone and ignores otherwise. Neither is confirmed to the page, so
 * a failure is returned as what the person reads, and success is the window
 * closing.
 */
export async function quitWhenAsked(
	connection: BridgeConnection,
): Promise<string | undefined> {
	try {
		await createHttpBridge(connection).app('close', { decision: 'proceed' });
		return undefined;
	} catch (cause) {
		window.location.assign(`${connection.origin}${QUIT_PATH}`);
		return `Whispering could not confirm the quit: ${describe(cause)}. If the window stays open, use Force Quit.`;
	}
}
