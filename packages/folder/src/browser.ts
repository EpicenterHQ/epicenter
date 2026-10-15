/**
 * `@epicenter/folder/browser`: a folder in this browser's own storage, and
 * nothing else.
 *
 * The same `openFolder`, `openDataFolder`, and contract as
 * `@epicenter/folder`, with the choice already made. A build that imports
 * this entry, or aliases the bare specifier to it, carries no desktop
 * adapter. Inside the desktop app
 * these openers refuse: that page's folders are directories the shell owns.
 *
 * Importing this module opens nothing.
 */
export { openDataFolder, openFolder } from './browser-adapter.js';
export * from './contract.js';
