/**
 * Instance-token resolver unit tests (ADR-0075).
 *
 * Pins the instance bearer path: the resolver maps an exact, constant-time
 * bearer match to the instance principal id and everything else to
 * `InvalidToken`. Credential extraction (missing header, non-bearer scheme,
 * subprotocol entries) belongs to the surface wrappers, so the resolver only
 * ever sees a bare token; the wrappers' HTTP/WebSocket shaping is covered in
 * `require-auth.test.ts` and the document/attach route tests. The pure generator
 * + entropy gate (`generateInstanceToken` / `assertStrongToken`) live in
 * `@epicenter/auth` and are tested there.
 */

import { expect, test } from 'bun:test';
import { INSTANCE_PRINCIPAL_ID } from '@epicenter/identity';
import type { Context } from 'hono';
import type { Env } from '../types.js';
import { createEnvTokenResolver } from './instance-token.js';

const TOKEN = 'instance-token-0123456789abcdef0123456789abcdef';

/** The resolver never reads the context; an empty stand-in keeps that honest. */
const context = {} as Context<Env>;

const resolve = createEnvTokenResolver(TOKEN);

test('resolves the instance principal for an exact bearer match', async () => {
	const { data, error } = await resolve(context, TOKEN);
	expect(error).toBeNull();
	expect(data).toEqual({ id: INSTANCE_PRINCIPAL_ID });
	expect(data?.email).toBeUndefined();
});

test('rejects a mismatched token with InvalidToken', async () => {
	const { data, error } = await resolve(context, `${TOKEN}-wrong`);
	expect(data).toBeNull();
	expect(error?.name).toBe('InvalidToken');
});

test('rejects a token that is only a prefix of the configured token', async () => {
	const { error } = await resolve(context, TOKEN.slice(0, -1));
	expect(error?.name).toBe('InvalidToken');
});
