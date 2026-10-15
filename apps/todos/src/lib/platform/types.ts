/**
 * The seam between the Todos UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf opens the
 * directory the desktop shell owns; the browser leaf opens a folder in
 * OPFS. Both answer the same folder handle, so the UI lists, edits, and
 * hears change hints the same way in either build.
 */
import type {
	Folder,
	FolderDefinition,
	OpenFolderError,
} from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import manifest from '../../../epicenter.app.json';
import type { todosDefinition } from '../definition.js';

/**
 * A folder read through Todos's definition. Its own `definition` is
 * `todosDefinition` for Todos's own folder, and the folder's declaration for
 * any other folder the desktop opens with Todos's shape as the lens.
 */
export type TodosFolder = Folder<typeof todosDefinition, FolderDefinition>;

/**
 * Todos's own folder, named by its app id in `epicenter.app.json`. The
 * browser names its OPFS directory after it and opens no other; the desktop
 * shell registers its directory under it and hands it to a window opened
 * without a folder.
 */
export const TODOS_FOLDER_ID = manifest.id;

/**
 * The folder a leaf opened, and whether it is Todos's own folder,
 * `TODOS_FOLDER_ID`. Only Todos's own folder offers Connect: Epicenter's
 * server keeps a repository per app id today, so any other folder would be
 * connected to Todos's repository.
 */
export type OpenedTodosFolder = {
	readonly folder: TodosFolder;
	readonly own: boolean;
};

/**
 * Opens the build's folder, writing nothing. A refusal is returned for the
 * page to show; a leaf never opens another kind of storage instead.
 */
export type OpenTodosFolder = () => Promise<
	Result<OpenedTodosFolder, OpenFolderError>
>;
