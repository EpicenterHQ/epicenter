/**
 * What the store's dial actually offers when a real auth client is the
 * transport.
 *
 * This is the one seam neither package could cover alone, and the gap was not
 * hypothetical. `attachStoreSync` called `openWebSocket(url)` with no
 * protocols; every authenticated client appends `bearer.<token>` to whatever it is
 * given; and the rooms route refuses an upgrade that offers protocols without
 * `epicenter`. So a browser replica offered exactly `['bearer.…']` and every
 * dial came back 400.
 *
 * `packages/data`'s own dial test fakes the transport, and `packages/auth`'s
 * contract test fakes the caller, so each half passed while the pair was
 * broken. This file is where they meet: the real `attachStoreSync`, the real
 * `createSessionAuth`, and a `WebSocket` constructor that records what it was
 * asked for.
 */

import { expect, test } from 'bun:test';
import { createSessionAuth } from '@epicenter/auth';
import {
	defineData,
	defineTable,
	field,
	plainText,
} from '@epicenter/data/definition';
import { openMemory } from '@epicenter/data/memory';
import { attachStoreSync } from '@epicenter/data/sync';
import { asPrincipalId } from '@epicenter/principal';
import {
	BEARER_SUBPROTOCOL_PREFIX,
	MAIN_SUBPROTOCOL,
} from '@epicenter/sync/auth-subprotocol';

const definition = defineData({
	id: 'so.epicenter.subprotocol-test',
	kv: {},
	tables: {
		notes: defineTable({ title: field.string(), content: plainText() }),
	},
});

const BASE_URL = 'https://api.epicenter.test';

test('the dial offers the main subprotocol beside the bearer', async () => {
	const openings: { url: string; protocols: string[] }[] = [];
	// Enough of a socket for the driver to attach its four listeners to. It
	// never opens, which is all this test needs: what is under examination is
	// the upgrade request, not the session after it.
	const WebSocketRecorder = class {
		binaryType = 'blob';
		constructor(url: string | URL, protocols: string[] = []) {
			openings.push({ url: String(url), protocols });
		}
		addEventListener() {}
		send() {}
		close() {}
	} as unknown as typeof WebSocket;

	const persisted = {
		token: 'access-token',
		principalId: asPrincipalId('user-1'),
	};

	// The real client, with only its two runtime edges injected: the fetch that
	// verifies `/api/session` and the constructor that would open the socket.
	const auth = createSessionAuth({
		baseURL: BASE_URL,
		persistedAuthStorage: { initial: persisted, set: async () => undefined },
		launcher: { startSignIn: async () => ({ status: 'launched' }) },
		WebSocket: WebSocketRecorder,
		fetch: async (input) =>
			String(input instanceof Request ? input.url : input).endsWith(
				'/api/session',
			)
				? Response.json({ principalId: 'user-1' })
				: new Response(null, { status: 204 }),
	});

	const store = await openMemory(definition);
	const connection = attachStoreSync({
		onRetired() { throw new Error('Unexpected retirement in this transport test'); },
		store,
		address: { baseURL: BASE_URL, dataId: definition.id, generation: 1 },
		transport:
			auth.state.status === 'signed-out'
				? (() => {
						throw new Error('No test account');
					})()
				: auth.state.account,
		onTransportError: (cause) => {
			throw cause;
		},
	});

	// The dial verifies the credential before it constructs anything, so the
	// recorder is empty until that round trip settles.
	while (openings.length === 0) await Bun.sleep(0);

	const opened = openings[0];
	if (opened === undefined) throw new Error('Expected one dial.');
	expect(new URL(opened.url).searchParams.get('dataId')).toBe(definition.id);
	// The order is the wire's: the main subprotocol first, because the mount
	// echoes only that one back on the 101, and the bearer beside it because a
	// browser upgrade cannot set `Authorization`.
	expect(opened.protocols).toEqual([
		MAIN_SUBPROTOCOL,
		`${BEARER_SUBPROTOCOL_PREFIX}access-token`,
	]);

	connection[Symbol.dispose]();
	auth[Symbol.dispose]();
	await store[Symbol.asyncDispose]();
});
