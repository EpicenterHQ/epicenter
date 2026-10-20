/**
 * `@epicenter/folder/tauri`: the directory the desktop shell bound to this
 * window, and nothing else.
 *
 * `openFolder({ tables })` opens it; the page names no path, scope, or
 * window. The handle reads and saves its files through the shell's storage
 * commands (`native/tauri.ts`), each answered in the calling window's
 * directory. A build that imports this entry, or aliases the bare specifier
 * to it, carries no browser storage. Outside the desktop app the opener
 * refuses; it never opens browser storage instead.
 *
 * The shell installs the `tauri-plugin-epicenter-folder` crate and binds
 * each window's directory before the window exists. Importing this module
 * does none of that and opens nothing.
 */
export * from './contract.js';
export { updateSavedView } from './native/saved-views.js';
export { openTauriFolder as openFolder } from './native/tauri.js';
