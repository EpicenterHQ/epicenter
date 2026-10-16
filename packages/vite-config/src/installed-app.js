/**
 * The installed app build: the one the Epicenter desktop host serves
 * (ADR-0552). Each folder app's `build:installed` script selects it with
 * `EPICENTER_HOST=1`; every other build is the browser build.
 *
 * Plain JavaScript with JSDoc types that imports nothing, so an app's
 * `svelte.config.js` loads it under any Node without type stripping. `installedAppViteConfig` in this package's entry reads the
 * same answer for Vite.
 */
/** @returns {boolean} */
export function isInstalledAppBuild() {
	return process.env.EPICENTER_HOST === '1';
}

/**
 * adapter-static options for a folder app. Both builds are client-only static
 * SPAs.
 *
 * The installed build writes `dist/` in the app's folder, which Epicenter
 * keeps (ADR-0560). Every route is prerendered (each app's
 * `src/routes/+layout.ts` reads `import.meta.env.EPICENTER_HOST`), so assets
 * load from relative paths and the page runs wherever the host serves it. It
 * has no fallback page, which would load its assets from absolute paths.
 *
 * The browser build writes adapter-static's default `build/` and serves
 * `index.html` as the fallback for every route.
 *
 * @returns {{ pages: string; assets: string } | { fallback: string }}
 */
export function installedAppAdapterOptions() {
	return isInstalledAppBuild()
		? { pages: 'dist', assets: 'dist' }
		: { fallback: 'index.html' };
}
