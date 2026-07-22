/**
 * Bun-owned routes on the one trusted Epicenter origin.
 *
 * The surface catalog is deliberately closed and compiled. Rust can mirror
 * the IDs, paths, and stable window labels without discovering or loading an
 * application registry. The bootstrap route is host infrastructure: Tauri
 * exchanges the per-launch credential there before any SPA reaches domain
 * code.
 */

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
	home: surface('home', 'Home'),
	whispering: surface('whispering', 'Whispering'),
	mail: surface('mail', 'Mail'),
	books: surface('books', 'Books'),
} as const;

export type SurfaceId = keyof typeof SURFACE_ROUTES;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const ACCOUNT_SIGN_IN_ROUTE = route('/_epicenter/account/sign-in');
export const ACCOUNT_SIGN_OUT_ROUTE = route('/_epicenter/account/sign-out');
export const ACCOUNT_INSTANCE_ROUTE = route('/_epicenter/account/instance');
export const ACCOUNT_PROFILE_ROUTE = route('/_epicenter/account/profile');
export const HOME_ROUTE = SURFACE_ROUTES.home;
export const WHISPERING_ROUTE = SURFACE_ROUTES.whispering;
export const MAIL_ROUTE = SURFACE_ROUTES.mail;
export const BOOKS_ROUTE = SURFACE_ROUTES.books;
export const SESSION_ROUTE = route('/api/home/session');
export const SESSION_STREAM_ROUTE = route('/api/home/session/stream');
