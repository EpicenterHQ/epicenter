import { createBrowserSecrets } from '@epicenter/device/browser';
import { createDesktopSecrets } from '@epicenter/device/desktop';
import { isTauri } from '@tauri-apps/api/core';

/** Open one device-local credential namespace. Closure retains saved credentials. */
export async function openSecrets({ id }: { id: string }) {
	const lifetime = new AbortController();
	const owner = (isTauri() ? createDesktopSecrets : createBrowserSecrets)(id, {
		assertUsable: () => lifetime.signal.throwIfAborted(),
	});
	let closing: Promise<void> | undefined;
	return Object.freeze({
		...owner.value,
		signal: lifetime.signal,
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			lifetime.abort();
			owner.close().then(completion.resolve, completion.reject);
			return closing;
		},
	});
}
export type Secrets = Awaited<ReturnType<typeof openSecrets>>;
