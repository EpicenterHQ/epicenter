/**
 * Boot-time Opensidian client (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * `openOpensidianBrowser` (see `opensidian.browser.ts` at the package root)
 * reads the persisted `auth.state` ONCE at startup and wires either the bare
 * local doc (signed out) or principal-scoped storage plus relay sync (signed in /
 * reauth-required). Construction is synchronous; data still loads async
 * behind `whenReady`. Identity changes are never an in-place swap:
 * `reloadOnPrincipalChange` (mounted in the root layout) reloads the page so the
 * next boot re-runs this selection.
 *
 * `opensidian` composes that browser bundle with Opensidian's reactive
 * editor/file/search/terminal state. There is no `require*()` accessor and no
 * HMR dispose block: the workspace is never `null`, so nothing gates on it
 * existing (matches Whispering's `whispering` singleton).
 *
 * ADR-0086 retires Opensidian's chat prototype (its cross-device tool catalog
 * over the relay floor included): the super app is its successor. This
 * conversion deletes `createCrossDeviceToolsState`, `createAgentChatState`,
 * and the skill/model/system-prompt scaffolding that only fed the chat's
 * system prompt, rather than adapting them to build outside a signed-in-only
 * session.
 */

import { openOpensidianBrowser } from 'opensidian/browser';
import { auth } from '$lib/platform/auth';
import { createEditorState } from './state/editor-state.svelte';
import { createFilesState } from './state/files-state.svelte';
import { createPaletteSearchState } from './state/palette-search-state.svelte';
import { createSidebarSearchState } from './state/sidebar-search-state.svelte';
import { createTerminalState } from './state/terminal-state.svelte';
import { createSampleDataLoader } from './utils/load-sample-data.svelte';

const browser = openOpensidianBrowser({ auth });

const editor = createEditorState();
const files = createFilesState({ workspace: browser });
const paletteSearch = createPaletteSearchState({ files, workspace: browser });
const sidebarSearch = createSidebarSearchState({ workspace: browser });
const terminal = createTerminalState({ files, workspace: browser });
const sampleData = createSampleDataLoader(browser);

export const opensidian = {
	...browser,
	state: {
		editor,
		files,
		paletteSearch,
		sidebarSearch,
		terminal,
		sampleData,
	},
	/** Resolves when local persistence has hydrated the root doc. */
	whenReady: browser.storage.whenLoaded,
};
