/**
 * `@epicenter/folder/browser`: a folder in this browser's own storage, and
 * nothing else.
 *
 * The same `openFolder` and contract as `@epicenter/folder`, with the choice
 * already made. A build that imports this entry, or aliases the bare
 * specifier to it, carries no desktop adapter. Inside the desktop app the
 * opener refuses: that page's folders are directories the shell owns.
 *
 * Importing this module opens nothing.
 */
export { openFolder } from './browser-adapter.js';
export * from './contract.js';
