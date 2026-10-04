/**
 * Bun-owned routes on the one trusted Epicenter origin.
 *
 * The surface catalog is deliberately closed and compiled. Rust can mirror
 * the IDs, paths, and stable window labels without discovering or loading an
 * application registry. The bootstrap route is host infrastructure: Tauri
 * exchanges the per-launch credential there before any SPA reaches domain
 * code.
 */

import { LOCAL_BLOB_PATH } from '@epicenter/blobs/webview';

const stripTrailing = (value: string) => value.replace(/\/+$/, '');

function route(pattern: string) {
	return {
		pattern,
		url: (baseUrl: string) => `${stripTrailing(baseUrl)}${pattern}`,
	} as const;
}

function surface<const TId extends string>(id: TId, title: string) {
	return {
		id,
		title,
		windowLabel: id,
		...route(`/apps/${id}/`),
	};
}

export const SURFACE_ROUTES = {
	query: surface('query', 'Query'),
	whispering: surface('whispering', 'Whispering'),
	mail: surface('mail', 'Mail'),
	books: surface('books', 'Books'),
} as const;

export type SurfaceId = keyof typeof SURFACE_ROUTES;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const QUERY_ROUTE = SURFACE_ROUTES.query;
export const WHISPERING_ROUTE = SURFACE_ROUTES.whispering;
export const MAIL_ROUTE = SURFACE_ROUTES.mail;
export const BOOKS_ROUTE = SURFACE_ROUTES.books;
export const SESSION_ROUTE = route('/api/query/session');
export const SESSION_STREAM_ROUTE = route('/api/query/session/stream');
export const LOCAL_BLOB_ROUTE = {
	pattern: `${LOCAL_BLOB_PATH}/:blobId`,
} as const;
