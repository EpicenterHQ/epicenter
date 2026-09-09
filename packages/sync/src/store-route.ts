/**
 * The store transport's one connect address, shared by every replica and the
 * route that answers them.
 *
 * It lives here rather than in the server because both halves need it and only
 * one of them is a server: a browser replica builds this address, and a page
 * has no business importing Hono to learn what path to ask for.
 *
 * One path, and the addressing lives in the query. A replica says which
 * application id it is syncing and how far through the log it has read.
 * WHOSE data that is comes from the resolved bearer, server-side, and is never
 * in the query at all, so there is no value a client can put here that reaches
 * another partition (ADR-0092).
 */

import { MAIN_SUBPROTOCOL } from './auth-subprotocol.js';
import type { WebSocketAddress } from './transport.js';

const stripTrailing = (value: string): string => value.replace(/\/+$/, '');

export const STORE_SYNC_ROUTE = {
	pattern: '/api/store/v1/sync',
	/**
	 * Where this replica connects, asking for everything after `cursor`.
	 *
	 * The URL and the subprotocol list travel together because a dial needs
	 * both: a browser upgrade cannot set `Authorization`, so the main
	 * subprotocol rides beside the URL and auth appends `bearer.<token>` to the
	 * same list (ADR-0346).
	 *
	 * The cursor is the replica's own durably applied position in this
	 * generation's log, so a reconnect is a catch-up rather than a fresh start
	 * (ADR-0222, ADR-0298).
	 *
	 * `generation` is the exact database being synced, and it is what the
	 * `document` membership stamp used to be (ADR-0231, retired by ADR-0292).
	 * A generation is created once, complete, and never mutated in place, so
	 * the address IS the identity: a replica addressed at generation 3 cannot
	 * be holding some other history's bytes, and there is nothing left to
	 * compare on a dial. What used to be an opaque stamp negotiated at first
	 * entanglement is now a number the page already had in its URL.
	 */
	address(
		baseURL: string,
		params: {
			dataId: string;
			generation: number;
			cursor: number;
			appId?: string;
			library?: 'personal' | 'shared';
		},
	): WebSocketAddress {
		const url = new URL(`${stripTrailing(baseURL)}${STORE_SYNC_ROUTE.pattern}`);
		url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		url.searchParams.set('dataId', params.dataId);
		url.searchParams.set('generation', String(params.generation));
		url.searchParams.set('cursor', String(params.cursor));
		if (params.appId) url.searchParams.set('appId', params.appId);
		if (params.library) url.searchParams.set('library', params.library);
		return { url: url.toString(), protocols: [MAIN_SUBPROTOCOL] };
	},
} as const;

/**
 * An id a data definition could actually have declared (ADR-0276).
 *
 * The value is `defineData({ id })`, so `data` is the noun on both sides. It is
 * not a database: ADR-0269 deleted the SQL projection the word came from. And
 * it is not a store: opening this definition produces one of those, and an
 * application opens two, local and account. This id names what they are
 * definitions OF.
 *
 * Checked on both sides, from one definition. The server checks it because the
 * value becomes part of a Durable Object name; a client checks nothing, but
 * sharing the grammar means a name the server will refuse is a name no
 * definition could have carried either.
 */
export const DATA_ID =
	/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/;
