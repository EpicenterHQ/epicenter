/**
 * What a `#platform/app` leaf throws when this page's world cannot open:
 * the reason, and what the recovery screen needs to offer a fix. SvelteKit
 * routes the rejected page module to `+error.svelte`; `hooks.client.ts`
 * hands `failure` through as `page.error.startup`. Retry is a reload.
 *
 * Its own module so the hook and the error page import it without importing
 * the world.
 */
export class StartupFailed<TFailure = unknown> extends Error {
	override name = 'StartupFailed';
	constructor(
		message: string,
		readonly failure: TFailure,
	) {
		super(message);
	}
}
