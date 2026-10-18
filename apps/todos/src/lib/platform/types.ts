/**
 * The seam between the Todos UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf opens the
 * directory the desktop shell owns; the browser leaf opens a folder in
 * OPFS. Both answer the same folder handle, so the UI edits, lists, hears
 * change hints, and runs its terminal the same way in either build.
 */
import type { Folder, OpenFolderError } from '@epicenter/folder';
import type { Result } from 'wellcrafted/result';
import type { todosDefinition } from '../definition.js';

export type TodosFolder = Folder<typeof todosDefinition>;

/**
 * The folder both leaves open. The browser names its scoped OPFS directory after
 * it; the desktop shell registers its directory under it.
 */
export const TODOS_FOLDER_ID = 'so.epicenter.todos';

/**
 * Opens the build's folder. A refusal is returned for the page to show; a
 * leaf never opens another kind of storage instead.
 */
export type OpenTodosFolder = () => Promise<
	Result<TodosFolder, OpenFolderError>
>;

/**
 * Run `handler` when this window is asked to close: its close button, Quit,
 * or a host restart. Tauri awaits the handler; `preventDefault` keeps the
 * window open, and once the handler returns otherwise, the window is
 * destroyed. Resolves to how to stop listening.
 */
export type OnCloseRequested = (
	handler: (event: { preventDefault(): void }) => void | Promise<void>,
) => Promise<() => void>;
