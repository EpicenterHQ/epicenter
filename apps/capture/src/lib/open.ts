import { openPersonal } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { captureDefinition } from '@epicenter/capture';

/** The page owns one Personal handle for its captured Account. */
export async function openCapture(account: Account, signal: AbortSignal) {
	signal.throwIfAborted();
	const store = await openPersonal(captureDefinition, { account });
	const close = () => {
		void store.close();
	};
	if (signal.aborted) {
		await store.close();
		signal.throwIfAborted();
	}
	signal.addEventListener('abort', close, { once: true });
	store.signal.addEventListener(
		'abort',
		() => signal.removeEventListener('abort', close),
		{ once: true },
	);
	return store;
}
