/**
 * `@epicenter/folder/tauri`: a directory the desktop shell registered, and
 * nothing else.
 *
 * `openFolder({ tables })` opens the folder the shell assigned to this window.
 * `openFolder({ directory, tables })` opens another registered folder;
 * `directory` is an ID, never a path. Both read and
 * saves its files through the shell's storage commands (`native/tauri.ts`).
 * A build that imports this entry, or aliases the bare specifier to it,
 * carries no browser storage. Outside the desktop app the opener refuses; it
 * never opens browser storage instead.
 *
 * The shell installs the `tauri-plugin-epicenter-folder` crate and registers
 * each folder's directory under an ID for the windows that may edit it.
 * Importing this module does none of that and opens nothing.
 */
export * from './contract.js';
export { openTauriFolder as openFolder } from './native/tauri.js';
