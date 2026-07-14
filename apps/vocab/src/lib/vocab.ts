/**
 * Boot-time Vocab client (ADR-0088: sign-in is an enhancement, never a
 * door).
 *
 * `openVocabBrowser` reads the persisted `auth.state` ONCE at startup and
 * wires either bare local IndexedDB (signed out) or principal-scoped storage
 * plus relay sync (signed in / reauth-required), including the
 * per-conversation message child docs. Construction and KV hydration complete
 * before the singleton is exported. Identity changes are never an
 * in-place swap: `reloadOnPrincipalChange` (mounted in the root layout) reloads
 * the page so the next boot re-runs this selection.
 *
 * The workspace is never nullable.
 */

import { openVocabBrowser } from '@epicenter/vocab/browser';
import { createNodeId } from '@epicenter/workspace';
import { auth } from '$lib/platform/auth';

const nodeId = createNodeId({ storage: localStorage });

const browser = await openVocabBrowser({ auth, nodeId });

export const vocab = {
	...browser,
	/** KV is hydrated by open; these reads gate first paint on both row planes. */
	whenReady: Promise.all([
		browser.tables.conversations.list(),
		browser.tables.entries.list(),
	]).then(() => undefined),
};
