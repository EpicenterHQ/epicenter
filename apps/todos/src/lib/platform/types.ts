/**
 * The seam between the Todos UI and where its folder lives.
 *
 * `#platform/folder` resolves at build time. The Epicenter host leaf opens the
 * directory the desktop shell owns; the browser leaf opens a folder in
 * OPFS. Both answer the same folder handle, so the UI lists, edits, and
 * hears change hints the same way in either build.
 */
import type { Folder, OpenFolderError } from '@epicenter/folder';
import type { Component } from 'svelte';
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

/** What Connect shows to choose a remote: the account's GitHub repositories, or a URL. */
export type ConnectPickerProps = {
	/** A connect is running; nothing new is chosen until it ends. */
	readonly busy: boolean;
	/** Connect the folder to this remote URL. */
	readonly onchoose: (url: string) => void;
};

export type GitHubReturnProps = {
	/** The address GitHub returned to: `/sync?github_code&github_state`, or `github_error`. */
	readonly url: URL;
	/** Leave `/sync` for the list. */
	readonly onfinished: () => void;
};

/**
 * `#platform/connect`: how a person chooses the folder's remote. In a browser,
 * a private GitHub repository through their Epicenter account, and the `/sync`
 * page GitHub returns to; on the desktop, any Git URL their own Git reaches.
 */
export type TodosConnect = {
	readonly Picker: Component<ConnectPickerProps>;
	readonly GitHubReturn?: Component<GitHubReturnProps>;
};
