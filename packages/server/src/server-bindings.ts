/**
 * The portable env contract `@epicenter/server` reads, as BOTH an arktype
 * schema (the runtime value) and its inferred type (the same name, the
 * `Principal` convention). It is the `Env.Bindings` type the Hono context uses
 * (see types.ts) and the SSOT a Bun host validates `process.env` against at
 * boot (see apps/api/server.ts).
 *
 * Deliberately NOT `Cloudflare.Env` (ADR-0066): it lists only the portable
 * STRING secrets library code reads, so library code names no Cloudflare type
 * and a Bun host typechecks AND validates with no Cloudflare types in scope.
 * Because every member is a string, a Bun entry runs the schema over
 * `process.env` and gets a typed env with no cast; a missing or malformed
 * secret fails fast with a descriptive error instead of a downstream surprise.
 *
 * What is deliberately ABSENT, and why:
 * - Object / namespace bindings (`STORE_AUTHORITY`, `HYPERDRIVE`) are not strings
 *   and cannot be validated from
 *   `process.env`. They live on the deployment's own `Cloudflare.Env` and are
 *   read by deployment resolvers at the `apps/*` edge, never by library code
 *   reaching for a binding shape. With the assets route retired into the
 *   portable blob store, the library now names NO Cloudflare object binding,
 *   by value or by type.
 * - The relational-auth secrets (`BETTER_AUTH_SECRET` and the OAuth provider
 *   credentials) are NOT here: the relational-auth substrate is a Cloud-only
 *   layer, so its env is `CloudAuthBindings` (beside `createAuth`), supplied
 *   by the cloud at its own edge and passed directly to `createAuth`. Keeping
 *   them out of the portable contract is what makes it truly portable: the
 *   single-partition instance's env never inherits a secret it does not read
 *   (ADR-0076).
 * - The deployment's public origin and any other cloud-only secrets (Autumn,
 *   admin IDs) are deployment config, supplied through `resolveOrigin` /
 *   policies.
 *
 * Each deployment's real env is a superset assignable to this: apps/api asserts
 * `satisfies ServerBindings` on its generated `Cloudflare.Env`, apps/self-host
 * declares `extends ServerBindings`, and the Bun host's validated `process.env`
 * is exactly this shape.
 */

import { type } from 'arktype';

export const ServerBindings = type({
	// Owner-addressed hosted blob storage: a portable S3 client over
	// aws4fetch with NO Workers R2 binding, so the identical code runs on the
	// Worker (against R2) and on a Bun host (against Garage/S3). All
	// optional: hosted blob routes return 503 when storage is unconfigured.
	// `BLOBS_S3_BUCKET` defaults to `epicenter-blobs` and `BLOBS_S3_REGION` to
	// `auto` (R2's region) when unset.
	'BLOBS_S3_ENDPOINT?': 'string',
	'BLOBS_S3_ACCESS_KEY_ID?': 'string',
	'BLOBS_S3_SECRET_ACCESS_KEY?': 'string',
	'BLOBS_S3_BUCKET?': 'string',
	'BLOBS_S3_REGION?': 'string',
	// AI provider house keys are optional: set one to serve that provider
	// through the gateway (routes/inference.ts, routes/transcription.ts), or omit
	// it and a request for that provider gets 503 ProviderNotConfigured.
	// House-key-only (ADR-0054).
	'OPENAI_API_KEY?': 'string',
	'GEMINI_API_KEY?': 'string',
});

/** The portable env contract; also the Hono `Env.Bindings` type (types.ts). */
export type ServerBindings = typeof ServerBindings.infer;
