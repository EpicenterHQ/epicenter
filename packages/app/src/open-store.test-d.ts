/** Account identity is an acquisition input, never a public store capability. */
import type { openLocal, openPersonal } from './open-store.js';
export function storeIdentityIsPrivate(
	local: Awaited<ReturnType<typeof openLocal>>,
	personal: Awaited<ReturnType<typeof openPersonal>>,
) {
	// @ts-expect-error Local exposes capabilities, not account identity.
	local.identity;
	// @ts-expect-error Personal captures identity privately.
	personal.identity;
	// @ts-expect-error Personal does not expose its captured Account.
	personal.account;
	// @ts-expect-error Flattening identity is not part of the store API.
	personal.principalId;
	// @ts-expect-error Authority remains private too.
	personal.authorityId;
}
