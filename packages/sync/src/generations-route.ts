/**
 * The generations collection: where a database's history is listed, created,
 * and fetched (ADR-0292, ADR-0293).
 *
 * It lives beside `store-route.ts` and for the same reason: both halves need
 * the path and only one of them is a server. A page building a bootstrap URL
 * has no business importing Hono to learn what to ask for.
 *
 * Three verbs over one collection, and the sync socket is deliberately not one
 * of them. HTTP carries getting a complete copy, which is parallel, resumable,
 * cacheable, and needs no protocol; the socket carries what is being edited.
 *
 * ```txt
 *  GET  /api/data/v1/<dataId>/generations       the numbers that exist
 *  POST /api/data/v1/<dataId>/generations       import: body is one whole state
 *  GET  /api/data/v1/<dataId>/generations/<n>   that generation's bytes
 * ```
 *
 * WHOSE data it is comes from the resolved bearer, server-side, and is never in
 * the path, so there is no value a client can write here that reaches another
 * partition (ADR-0092).
 */

const stripTrailing = (value: string): string => value.replace(/\/+$/, '');

/**
 * The log position the served bytes are current through.
 *
 * What makes a bootstrap worth making. Without it a device would seed a cursor
 * of zero, dial, and be handed the authority's snapshot, which is the same
 * state it just downloaded over HTTP; with it the socket carries only what
 * happened afterwards. Current-library downloads frame the snapshot and its
 * complete tail together; this header names the captured head they cover.
 * Historical generation responses carry their snapshot's position.
 */
export const LOG_POSITION_HEADER = 'epicenter-log-position';
export const CURRENT_GENERATION_HEADER = 'epicenter-generation';

/** The stable application library. Account authentication still identifies the actor. */
export const CURRENT_ROUTE = {
	pattern: '/api/libraries/:appId/:library/data/:dataId/current',
	url(
		baseURL: string,
		appId: string,
		library: 'personal' | 'shared',
		dataId: string,
	) {
		return `${stripTrailing(baseURL)}/api/libraries/${encodeURIComponent(appId)}/${library}/data/${encodeURIComponent(dataId)}/current`;
	},
};

export const GENERATIONS_ROUTE = {
	/** Every generation of one database. The `:dataId` is a path parameter. */
	collectionPattern: '/api/data/v1/:dataId/generations',
	/** One generation of one database. */
	itemPattern: '/api/data/v1/:dataId/generations/:generation',
	/** Where a device lists what exists, or posts an import. */
	collection(baseURL: string, dataId: string): string {
		return `${stripTrailing(baseURL)}/api/data/v1/${encodeURIComponent(dataId)}/generations`;
	},
	/** Where a device fetches one generation's whole state. */
	item(baseURL: string, dataId: string, generation: number): string {
		return `${GENERATIONS_ROUTE.collection(baseURL, dataId)}/${generation}`;
	},
} as const;
