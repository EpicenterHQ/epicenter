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
 * The folder both leaves open. The browser names its scoped OPFS directory after
 * it; the desktop shell registers its directory under it.
 */
export const TODOS_FOLDER_ID = 'so.epicenter.todos';

/**
 * Opens the build's folder. A refusal is returned for the page to show; a
 * leaf never opens another kind of storage instead. In the browser this is
 * the Local demo, opened only once the person chooses it.
 */
export type OpenTodosFolder = () => Promise<
	Result<TodosFolder, OpenFolderError>
>;

/** Where an open browser folder is kept and what Sync reaches, as the header names it. */
export type TodosPlace = {
	readonly kind: 'local' | 'account';
	/** Short: "Local demo", or the repository's full name. */
	readonly label: string;
	/** Where the todos are kept and where Sync sends them. */
	readonly detail: string;
};

export type StartProps = {
	/** Reopen the person's remembered choice; `false` shows the choice first. */
	readonly resume: boolean;
	/** The chosen folder is open. The page shows it until the person changes it. */
	readonly onopen: (folder: TodosFolder, place: TodosPlace) => void;
};

export type GitHubReturnProps = {
	/** The address GitHub returned to: `/sync?github_code&github_state`, or `github_error`. */
	readonly url: URL;
	/** Leave `/sync` for the start page. */
	readonly onfinished: () => void;
};

/**
 * `#platform/start`: what the browser shows before any folder opens, the
 * choice between the Local demo and the person's Epicenter account, and the
 * `/sync` page GitHub returns to. The desktop host has neither: it opens its
 * folder at once.
 */
export type TodosStart =
	| {
			readonly Start: Component<StartProps>;
			readonly GitHubReturn: Component<GitHubReturnProps>;
	  }
	| undefined;
