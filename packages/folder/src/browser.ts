/**
 * `@epicenter/folder/browser`: a folder in this browser's own storage, and
 * nothing else.
 *
 * The same `openFolder` and the same contract as `@epicenter/folder`, with
 * the choice already made. A build that imports this entry, or aliases the
 * bare specifier to it, carries no desktop adapter. Inside the desktop app
 * this opener refuses: that page's folder is a directory the shell owns.
 *
 * `downloadFolder` is this entry's alone: it makes a browser folder in an
 * explicit Local or account scope from remote history before the first open.
 * `inspectFolder` is too: it reports what a folder's directory holds, and the
 * remote a ready one is bound to, without creating or writing anything.
 *
 * Importing this module opens nothing.
 */
export {
	type DownloadError,
	type DownloadFolderOptions,
	downloadFolder,
	type FolderDownload,
	type FolderInspection,
	type FolderRemote,
	type InspectError,
	type InspectFolderOptions,
	inspectFolder,
	openFolder,
} from './browser-adapter.js';
export * from './contract.js';
export { DownloadFolderError } from './errors.js';
