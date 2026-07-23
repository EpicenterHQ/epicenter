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
export const HOME_SNAPSHOT_CAPTURE_ROUTE = route('/api/home/data/snapshots');
export const HOME_DATA_OVERVIEW_ROUTE = route('/api/home/data');
export const HOME_DATA_COLLECTION_ROUTE = route(
	'/api/home/data/lenses/:lens/collections/:collection',
);
export const HOME_SNAPSHOT_QUERY_ROUTE = route(
	'/api/home/data/snapshots/:snapshotId/query',
);
export const HOME_PROPOSALS_ROUTE = route('/api/home/data/proposals');
export const HOME_PROPOSAL_ROUTE = route(
	'/api/home/data/proposals/:proposalId',
);
export const HOME_PROPOSAL_COMPILE_ROUTE = route(
	'/api/home/data/proposals/:proposalId/compile',
);
export const HOME_PROPOSAL_APPLY_ROUTE = route(
	'/api/home/data/proposals/:proposalId/apply',
);

export function homeSnapshotQueryPath(snapshotId: string): string {
	return `/api/home/data/snapshots/${encodeURIComponent(snapshotId)}/query`;
}

export function homeDataCollectionPath(
	lens: string,
	collection: string,
): string {
	return `/api/home/data/lenses/${encodeURIComponent(lens)}/collections/${encodeURIComponent(collection)}`;
}

export function homeProposalPath(proposalId: string): string {
	return `/api/home/data/proposals/${encodeURIComponent(proposalId)}`;
}

export function homeProposalCompilePath(proposalId: string): string {
	return `${homeProposalPath(proposalId)}/compile`;
}

export function homeProposalApplyPath(proposalId: string): string {
	return `${homeProposalPath(proposalId)}/apply`;
}
