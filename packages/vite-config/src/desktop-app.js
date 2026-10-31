/**
 * The desktop build of a folder app that ships its own Tauri shell, such as
 * standalone Todos. The app's desktop build script selects it with
 * `EPICENTER_DESKTOP=1`; every other build is the browser build.
 *
 * Plain JavaScript with JSDoc types that imports nothing, so an app's
 * `svelte.config.js` loads it under any Node without type stripping.
 * `desktopAppViteConfig` in this package's entry reads the same answer for
 * Vite.
 */
/** @returns {boolean} */
export function isDesktopAppBuild() {
	return process.env.EPICENTER_DESKTOP === '1';
}

/**
 * adapter-static options for a folder app. Both builds are client-only static
 * SPAs.
 *
 * The desktop build writes `dist/` in the app's folder, which its Tauri shell
 * loads (`frontendDist`). Every route is prerendered (the app's
 * `src/routes/+layout.ts` reads `import.meta.env.EPICENTER_DESKTOP`), so
 * assets load from relative paths. It has no fallback page, which would load
 * its assets from absolute paths.
 *
 * The browser build writes adapter-static's default `build/` and serves
 * `index.html` as the fallback for every route.
 *
 * @returns {{ pages: string; assets: string } | { fallback: string }}
 */
export function desktopAppAdapterOptions() {
	return isDesktopAppBuild()
		? { pages: 'dist', assets: 'dist' }
		: { fallback: 'index.html' };
}
