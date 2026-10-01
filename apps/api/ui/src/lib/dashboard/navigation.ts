/** Only these website destinations can survive a sign-in round trip. */
const dashboardPaths = new Set([
	'/dashboard',
	'/dashboard/usage',
	'/dashboard/account',
]);

export const dashboardReturnKey = 'epicenter.dashboard.return-to';

/** A link names an expected account but never authenticates that account. */
export function readDashboardTarget(url: URL) {
	const principals = url.searchParams.getAll('expectedPrincipal');
	if (
		principals.length > 1 ||
		(principals.length === 1 &&
			(!principals[0] ||
				principals[0].length > 256 ||
				/\s/.test(principals[0])))
	)
		return { valid: false } as const;
	return { valid: true, expectedPrincipal: principals[0] ?? null } as const;
}

/** Refuse external redirects and paths outside the account website. */
export function readDashboardReturnPath(value: string | null, origin: string) {
	if (!value?.startsWith('/') || value.startsWith('//') || value.includes('\\'))
		return '/dashboard';
	try {
		const url = new URL(value, origin);
		if (
			url.origin !== origin ||
			!dashboardPaths.has(url.pathname) ||
			!readDashboardTarget(url).valid
		)
			return '/dashboard';
		return `${url.pathname}${url.search}${url.hash}`;
	} catch {
		return '/dashboard';
	}
}
