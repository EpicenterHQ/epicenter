/**
 * Bun-owned routes on the one trusted Device origin.
 *
 * The built-in route table is deliberately closed and compiled. Rust can mirror
 * the IDs and paths without discovering or loading an application registry, and
 * it derives its own window labels from those IDs: a window label is Tauri's
 * handle, so Bun states no opinion about one. The bootstrap route is host
 * infrastructure: Tauri exchanges the per-launch credential there before any
 * SPA reaches domain code.
 */

import { LOCAL_BLOB_PATH } from '@epicenter/blobs/webview';
import { CHECKOUT_PATH } from '@epicenter/data/artifact/checkout';
import {
	CALLBACK_PATH as MAIL_CALLBACK_PATH,
	PENDING_CALLBACK_PATH as MAIL_PENDING_CALLBACK_PATH,
} from '@epicenter/local-mail/authorization-return';

const stripTrailing = (value: string) => value.replace(/\/+$/, '');

function route(pattern: string) {
	return {
		pattern,
		url: (baseUrl: string) => `${stripTrailing(baseUrl)}${pattern}`,
	} as const;
}

function builtInRoute<const TId extends string>(id: TId, title: string) {
	return {
		id,
		title,
		...route(`/apps/${id}/`),
	};
}

export const BUILT_IN_ROUTES = {
	home: builtInRoute('home', 'Home'),
	whispering: builtInRoute('whispering', 'Whispering'),
	honeycrisp: builtInRoute('honeycrisp', 'Honeycrisp'),
	mail: builtInRoute('mail', 'Mail'),
	books: builtInRoute('books', 'Books'),
} as const;

export type BuiltInRouteId = keyof typeof BUILT_IN_ROUTES;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const ACCOUNT_SIGN_IN_ROUTE = route('/_epicenter/account/sign-in');
export const ACCOUNT_SIGN_OUT_ROUTE = route('/_epicenter/account/sign-out');
export const HOME_ROUTE = BUILT_IN_ROUTES.home;
export const WHISPERING_ROUTE = BUILT_IN_ROUTES.whispering;
export const HONEYCRISP_ROUTE = BUILT_IN_ROUTES.honeycrisp;
export const MAIL_ROUTE = BUILT_IN_ROUTES.mail;
export const BOOKS_ROUTE = BUILT_IN_ROUTES.books;
/** What Home lists as launchable (ADR-0189). */
export const APPLICATIONS_ROUTE = route('/api/apps');
export const SESSION_ROUTE = route('/api/home/session');
export const SESSION_STREAM_ROUTE = route('/api/home/session/stream');
export const LOCAL_BLOB_ROUTE = {
	pattern: `${LOCAL_BLOB_PATH}/:blobId`,
} as const;
/**
 * One database's working copy in `~/Device` (ADR-0337).
 *
 * `PUT` replaces the folder with the checkout in the body; `GET` hands back
 * what the folder holds. Both carry their files in an NDJSON body, so there is
 * no per-file path to route, capture, or validate. That is what the earlier
 * per-file design cost, and it cost it silently: Hono routes a bare `*` but
 * captures nothing under it, so every write arrived with an empty path.
 *
 * The `folder` segment this route used to carry named `local` or `account`,
 * and went with the device store: there is one store per data id (ADR-0336),
 * so there is one folder.
 *
 * The host takes the data id from the caller and does not verify that the
 * caller owns it, which is the trust model rather than a gap in it: a deployed
 * app is a trusted app (ADR-0334), and ADR-0118 decided that every SPA on this
 * origin is fully trusted. Do not add a per-app credential to close this. The
 * thing that would change it is an origin per app, so that the socket answers
 * who is asking and the id leaves the URL entirely.
 */
export const CHECKOUT_ROUTE = route(`${CHECKOUT_PATH}/:dataId`);
/**
 * Where Google returns a person after Local Mail's consent screen.
 *
 * It is the SPA's own client route, and that is deliberate: Google refuses a
 * custom URI scheme for a Desktop OAuth client, so the only redirect a desktop
 * app may register is a loopback address, and this socket is the loopback
 * address Local Mail already names. The redemption still happens in the Mail
 * WebView, which is the only place the PKCE verifier exists; the host does not
 * read the code, hold a credential, or talk to Google.
 *
 * A request here carries `code` or `error` only when it arrives from the
 * person's browser. Without one it is the WebView loading its own route, and
 * the SPA is served exactly as before.
 */
export const MAIL_CALLBACK_ROUTE = route(
	`${BUILT_IN_ROUTES.mail.pattern}${MAIL_CALLBACK_PATH}`,
);
/** Where the Mail window collects the callback the host is holding. */
export const MAIL_PENDING_CALLBACK_ROUTE = route(MAIL_PENDING_CALLBACK_PATH);
/**
 * Host-owned remote copy operations for one local blob. The id is the only
 * input: no route accepts a destination URL, transfer header, or body, so the
 * host's own deployment authority is the only reachable target.
 */
export const LOCAL_BLOB_REMOTE_ROUTES = {
	upload: { pattern: `${LOCAL_BLOB_PATH}/:blobId/upload` },
	download: { pattern: `${LOCAL_BLOB_PATH}/:blobId/download` },
	purge: { pattern: `${LOCAL_BLOB_PATH}/:blobId/purge` },
} as const;
