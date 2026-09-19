import { getContext, setContext } from 'svelte';

export type AppCleanup = {
	preflight?(): Promise<void>;
	close(): Promise<void>;
};
const cleanup = Symbol('app-cleanup');

/** One registration belongs to one AppBoot instance and survives its UI teardown. */
export function provideAppCleanup() {
	let owner: AppCleanup | undefined;
	setContext(cleanup, (next: AppCleanup) => {
		if (owner)
			throw new Error('This App already has a cleanup owner. Reload the page.');
		owner = next;
	});
	return () => owner;
}

/** Root UI only: register once during initialization, after its producers exist. */
export function registerAppCleanup(owner: AppCleanup) {
	const register = getContext<((owner: AppCleanup) => void) | undefined>(
		cleanup,
	);
	if (!register)
		throw new Error('Application cleanup requires an AppBoot ancestor.');
	register(owner);
}
