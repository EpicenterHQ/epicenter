/**
 * The seam between the Todos UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf opens the
 * directory the desktop shell owns; the browser leaf opens a folder in
 * OPFS. Both answer the same folder handle, so the UI lists, edits, and
 * hears change hints the same way in either build.
 */
import type { Folder, OpenFolderError } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import type { todosDefinition } from '../definition.js';

export type TodosFolder = Folder<typeof todosDefinition>;

/**
 * The folder both leaves open. The browser names its OPFS directory after it;
 * the desktop shell registers its directory under it.
 */
export const TODOS_FOLDER_ID = 'so.epicenter.todos';

/**
 * Opens the build's folder, writing nothing. A refusal is returned for the
 * page to show; a leaf never opens another kind of storage instead.
 */
export type OpenTodosFolder = () => Promise<
	Result<TodosFolder, OpenFolderError>
>;
