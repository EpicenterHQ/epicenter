/**
 * Cloudflare bindings for apps/self-host.
 *
 * Hand-written so this reference deployable typechecks without requiring a
 * Cloudflare account or a `wrangler types` run. The library's binding
 * contract is inherited from `ServerBindings`, so this file declares only
 * what the deployment itself owns. If you replace it with `wrangler types`
 * output, re-add the `extends` clause so the inherited bindings (the optional
 * OAuth keys and AI provider house keys) survive the regeneration.
 *
 * Hosted-only bindings (Autumn, ASSETS) are deliberately
 * absent: the instance reference has no billing surface and no dashboard SPA.
 */

/// <reference types="@cloudflare/workers-types" />

declare namespace Cloudflare {
	// Heritage clauses cannot contain import() type expressions (TS2499),
	// so the library contract is aliased before the extends.
	type ServerBindings = import('@epicenter/server').ServerBindings;

	interface Env extends ServerBindings {
		API_PUBLIC_ORIGIN: string;
		TRUSTED_BROWSER_ORIGINS: string;
		SELF_HOST_CALLBACKS: string;
		SELF_HOST_AUTH: DurableObjectNamespace<
			import('@epicenter/server/self-host-auth/worker').SelfHostAuthOwner
		>;
		STORE_AUTHORITY: DurableObjectNamespace<
			import('@epicenter/server').StoreAuthority
		>;
		GENERATIONS_LEDGER: DurableObjectNamespace<
			import('@epicenter/server').GenerationsLedger
		>;
	}
}

interface Env extends Cloudflare.Env {}
