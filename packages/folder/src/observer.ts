/**
 * Calling code the folder does not own.
 *
 * A change listener or a snapshot subscriber runs inside the folder's own
 * work: a snapshot is announced from the save that changed it, and a change
 * from the Sync that wrote it. What such a callback throws is its own
 * failure. It must not turn a save that landed into a rejection, stop the
 * commit request that follows it, or keep the listeners after it from
 * hearing.
 */
import { createLogger } from 'wellcrafted/logger';

const log = createLogger('folder/observer');

/** Call `observer`; report what it throws instead of letting it escape. */
export function callObserver<T>(
	what: string,
	observer: (value: T) => void,
	value: T,
): void {
	try {
		observer(value);
	} catch (cause) {
		log.error(new Error(`A folder ${what} threw.`, { cause }));
	}
}
