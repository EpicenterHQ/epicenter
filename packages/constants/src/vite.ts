/// <reference types="vite/client" />

import { APPS, type AppKey, localUrl } from '#apps';

/**
 * Flat URL strings resolved at Vite build time.
 *
 * `import.meta.env.MODE` is statically replaced by Vite:
 * - `vite dev`   → `'development'` → `http://localhost:<port>`
 * - `vite build` → `'production'`  → production URLs
 */
const isDev = import.meta.env.MODE !== 'production';

/** Optional self-hosted issuer baked into a frontend build. */
export const SELF_HOST_ORIGIN: string | undefined = import.meta.env
	.VITE_EPICENTER_SERVER;

export const APP_URLS = Object.fromEntries(
	Object.entries(APPS).map(([key, app]) => [
		key,
		isDev ? localUrl(app) : app.url,
	]),
) as { readonly [K in AppKey]: string };
