/**
 * The one thing this application reaches its recordings and recipes through.
 *
 * Two functions composed: `createEpicenter` knows nothing about Svelte,
 * file Honeycrisp and Vocab have, because it is the same composition.
 *
 * It replaces `openAccountRuntime`, which built a handle inside
 * `openWhisperingApp` on every `(app)` mount, awaited `open()`, and unwound the
 * result by hand when an `AbortSignal` fired mid-open. A handle per mount is
 * one handle too many for a document: opening is idempotent while `ready`
 * (ADR-0344), so the mount that used to build a rival now joins the session
 * this module owns.
 *
 * **This file is not a platform leaf, and there is one of it.** Nothing about
 * a data session varies by runtime: the store is client-owned in every build
 * (ADR-0226, ADR-0227), the definition is one file, and the account is already
 * selected next door.
 *
 * **Nothing opens when this module is evaluated.** What opens the store is
 * `epicenter.open(account)`, called once by `(app)/+layout.svelte` after auth is read.
 * `/auth/callback` and `/recording-overlay` are siblings of that group and
 * never reach it (ADR-0345).
 */

import { createEpicenter } from '@epicenter/app';
import { APPS } from '@epicenter/constants/apps';
import { appBlobs } from '#platform/app-blobs';
import { sqlite } from '#platform/sqlite';
import { recording } from '#platform/recording';
import { whisperingDefinition } from './data';

/**
 * The handle, module-private, because `close` is on it.
 *
 * The document is the lifetime (ADR-0088): an identity change replaces the
 * document, which is what ends the previous principal's replica, so no route
 * closes this. The one caller that wants a lifetime shorter than a document is
 * the hot reload below. What the application imports is the session, which has
 * no close on it at all.
 */
export const epicenter = createEpicenter({
	appId: APPS.WHISPERING.id,
	definition: whisperingDefinition,
	sqlite,
	blobs: appBlobs,
	recording,
});

// The disposer RETURNS the close, because Vite awaits it: the replacement
// module must not ask for the Web Lock while this document is still letting go
// of it. Construction is inert, so the replacement acquires nothing until the
// layout calls `open`.
