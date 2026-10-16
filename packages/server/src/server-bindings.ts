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
 * - Object bindings (`HYPERDRIVE`, `ARTIFACTS`) are not strings and cannot be
 *   validated from `process.env`. They live on the deployment's own
 *   `Cloudflare.Env` and are read by deployment resolvers at the `apps/*`
 *   edge, never by library code reaching for a binding shape. With the assets route retired into the
 *   portable blob store, the library now names NO Cloudflare object binding,
 *   by value or by type.
 * - The relational-auth secrets (`BETTER_AUTH_SECRET` and the OAuth provider
 *   credentials) are NOT here: their env is `CloudAuthBindings` (beside
 *   `createAuth`), supplied by each apps/api entry and passed directly to
 *   `createAuth`, so the route library never reads an auth secret.
 * - The deployment's public origin and any other cloud-only secrets (Autumn,
 *   admin IDs) are deployment config, supplied through `resolveOrigin` /
 *   policies.
 *
 * Each deployment's real env is a superset assignable to this: apps/api asserts
 * `satisfies ServerBindings` on its generated `Cloudflare.Env`, and its Bun
 * entry validates `process.env` against this schema merged with its own.
 */

import { type } from 'arktype';

export const ServerBindings = type({
	// Portable S3 client over aws4fetch, for R2 on the Worker and any
	// S3-compatible endpoint on Bun. All fields are optional: without an
	// endpoint and both keys, `resolveDeploymentBlobStore` returns null and the
	// blob routes answer 503. `BLOBS_S3_BUCKET` defaults to `epicenter-blobs` and `BLOBS_S3_REGION` to
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
