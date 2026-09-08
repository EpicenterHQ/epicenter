/**
 * The one thing this application reaches its notes through.
 *
 * Two functions composed: `createEpicenter` knows nothing about Svelte,
 *
 * **This file is not a platform leaf, and there is one of it.** Nothing about
 * a data session varies by runtime: the store is client-owned in every build
 * (ADR-0226, ADR-0227), the definition is one file, and the account is already
 * selected next door. The wiring, the singleton, and the one call that ends it
 * live here, in one copy, where they cannot drift between two leaves that
 * differ on an import line.
 *
 * `definition` and `account` arrive together, which is the store: an authority
 * mints every generation (ADR-0336), so there is no accountless notebook. The
 * explicit application id matches the definition here, but remains the
 * opening application's independent storage scope (ADR-0324).
 *
 * **Nothing opens when this module is evaluated.** Construction is inert in
 * both halves, so importing this claims no Web Lock, touches no IndexedDB, and
 * makes no round trip. What opens the notes is `epicenter.open(account)`, called once
 * by `routes/+page.svelte` after auth is ready; `/auth/callback` renders under
 * the same layout and never calls it.
 */

import { createEpicenter } from '@epicenter/app';
import { APPS } from '@epicenter/constants/apps';
import { honeycrispDefinition } from '$lib/data';

/**
 * The handle, module-private, because `close` is on it.
 *
 * Ending the store is the page's, and the one caller that needs a lifetime
 * shorter than a document is the hot reload three lines below. Keeping the
 * handle here is what makes that the only reachable caller: what the
 * application imports is the session, which has no close on it at all.
 */
export const epicenter = createEpicenter({
	appId: APPS.HONEYCRISP.id,
	definition: honeycrispDefinition,
});

// A hot swap of this module builds a second handle while the first still holds
// the Web Lock its store claimed, so the replacement opens into `AlreadyOpen`
// until the page is reloaded by hand. Closing releases all three things opening
// took, so the new module opens fresh.
//
// **The disposer RETURNS the close.** Vite awaits a disposer's result
// (`hmrClient.fetchUpdate`), so returning the promise is what makes "release
// the claim" happen before the replacement module runs. It used to be
// `void epicenter.close()`, which handed Vite `undefined` to await and left the
// release racing the reload: the new module could ask for the lock while the
// old document was still letting go of it, and the answer was a false
// `AlreadyOpen`. Construction being inert closes the rest of that gap, because
// the replacement acquires nothing until the page calls `open`.
//
// `accept` is what makes the `dispose` run. Vite disposes only the module an
// update was ACCEPTED at, and a module with no `accept` is never one: the
// update walks up to the nearest self-accepting importer, which is the page
// component, and the page's disposer runs instead of this one. Accepting makes
// this its own boundary; invalidating immediately says it cannot really handle
// the swap, so the update goes on up to the page exactly as it did before, with
// the old handle now closed.
if (import.meta.hot) {
	import.meta.hot.dispose(() => epicenter.close());
	import.meta.hot.accept(() => import.meta.hot?.invalidate());
}
