/**
 * `@epicenter/folder/tauri`: a folder whose directory the desktop shell
 * grants, and nothing else.
 *
 * The same `openFolder` and contract as `@epicenter/folder`, with the choice
 * already made. A build that imports this entry, or aliases the bare
 * specifier to it, carries no browser storage and no isomorphic-git; the
 * folder engine and its system-`git` backend load when a folder is granted.
 * Outside the desktop app the opener refuses; it never opens browser
 * storage instead.
 *
 * The shell installs the `tauri-plugin-epicenter-folder` crate and registers
 * each folder's directory under an ID for the windows that may edit it. An
 * app's window opens the folder the shell handed it (`window_folder`).
 * Importing this module does none of that and opens nothing.
 */
export * from './contract.js';
export { openFolder } from './tauri-adapter.js';
