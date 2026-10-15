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
	home: builtInRoute('home', 'Settings'),
	folders: builtInRoute('folders', 'Folders'),
} as const;

export const BOOTSTRAP_ROUTE = route('/_epicenter/bootstrap');
export const ACCOUNT_SIGN_IN_ROUTE = route('/_epicenter/account/sign-in');
export const SIGN_IN_CALLBACK_ROUTE = route('/_epicenter/sign-in/callback');
export const ACCOUNT_CANCEL_CONNECTION_ROUTE = route(
	'/_epicenter/account/cancel-connection',
);
export const ACCOUNT_SIGN_OUT_ROUTE = route('/_epicenter/account/sign-out');
export const HOME_ROUTE = BUILT_IN_ROUTES.home;
export const FOLDERS_ROUTE = BUILT_IN_ROUTES.folders;
export const SESSION_ROUTE = route('/api/home/session');
export const SESSION_STREAM_ROUTE = route('/api/home/session/stream');
