/**
 * `#platform/offline` in a browser: the page opens offline through its
 * service worker (`src/service-worker.js`), a module in dev and a classic
 * script in a build. The desktop window's leaf is `offline.tauri.ts`.
 */
import { dev } from '$app/environment';
import { base } from '$app/paths';

/** Register the service worker, best effort: the page works without it. */
export function openOffline(): void {
	if (!('serviceWorker' in navigator)) return;
	navigator.serviceWorker
		.register(`${base}/service-worker.js`, { type: dev ? 'module' : 'classic' })
		.catch(() => {});
}
