/**
 * The seam between the notes UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf opens
 * the folder Epicenter hands the installed app's window, a real directory;
 * the browser leaf opens a folder in OPFS. Both answer the same folder handle,
 * so the UI reads, writes, and shows where the notes are the same way in
 * either build.
 */
import type { Definition, Folder } from '@epicenter/folder';
import manifest from '../../../epicenter.app.json';
import type { honeycrispDefinition } from '../data.js';

/**
 * Honeycrisp's own folder, named by its app id in `epicenter.app.json`. The
 * browser names its scoped OPFS directory after it and opens no other;
 * Epicenter registers its own directory under it and hands it to a window
 * opened without a folder.
 */
export const HONEYCRISP_FOLDER_ID = manifest.id;

/**
 * The folder the notes UI uses, whole: `folderOptions` reads and writes it
 * through the query cache, and its change channel reports what changed
 * outside the page. The app never syncs; remotes are outside it. Its own
 * `definition` is `honeycrispDefinition` for Honeycrisp's own folder, and the
 * folder's declaration for any other folder Epicenter hands it, read through
 * Honeycrisp's definition.
 */
export type NotesFolder = Folder<typeof honeycrispDefinition, Definition>;

/**
 * Opens the build's notes folder. A folder that cannot be opened throws; a
 * leaf never opens another kind of storage instead. The page closes the
 * folder it opened.
 */
export type OpenNotesFolder = () => Promise<NotesFolder>;
