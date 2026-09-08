/**
 * The one thing this application reaches its entries and conversations
 * through.
 *
 * Two functions composed: `createEpicenter` knows nothing about Svelte,
 *
 * It replaces `openVocabRuntime`, which was this application's own copy of the
 * opener: resolve the generation, open the database, attach sync, hand back a
 * disposer. One thing that copy did not do was ask the page for a flush before
 * it went, so the last few seconds of typing were lost with no error anywhere.
 * The shared opener owns that listener, which is the reason a straggler is
 * worth migrating rather than leaving alone.
 *
 * `definition` and `account` arrive together, which is the store: an authority
 * mints every generation (ADR-0336), so there is no accountless pool. The
 * explicit application id is the opening application's independent storage
 * scope (ADR-0324), and it is self-claimed: a deployed app is a trusted app
 * (ADR-0334).
 *
 * **Nothing opens when this module is evaluated.** What opens the store is
 * `epicenter.open(account)`, called once by `routes/+page.svelte` after auth is read.
 */

import { createEpicenter } from '@epicenter/app';
import { createBrowserAppBlobs } from '@epicenter/app/browser';
import { APPS } from '@epicenter/constants/apps';
import { sqlite } from '#platform/sqlite';
import { vocabDefinition } from '$lib/data';

/**
 * The handle, module-private, because `close` is on it.
 *
 * The page is the lifetime (ADR-0088), and the one caller that wants a shorter
 * one is the hot reload below. What the application imports is the session,
 * which has no close on it at all.
 */
export const epicenter = createEpicenter({
	appId: APPS.VOCAB.id,
	definition: vocabDefinition,
	sqlite,
	blobs: createBrowserAppBlobs(),
});

// The disposer RETURNS the close, because Vite awaits it: the replacement
// module must not ask for the Web Lock while this document is still letting go
// of it. Construction is inert, so the replacement acquires nothing until the
// page calls `open`.
