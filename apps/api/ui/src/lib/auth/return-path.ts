import { readDashboardReturnPath } from '../dashboard/navigation.js';

/**
 * Where a plain sign-in continues: the `return` path the device approval page
 * or an account page sent, or `/dashboard`. Only those pages are accepted, so
 * a link cannot steer a signed-in browser anywhere else.
 */
export function readReturnPath(search: string, origin: string) {
	const values = new URLSearchParams(search).getAll('return');
	const value = values.length === 1 ? (values[0] ?? null) : null;
	if (
		value?.startsWith('/') &&
		!value.startsWith('//') &&
		!value.includes('\\')
	) {
		try {
			const url = new URL(value, origin);
			if (url.origin === origin && url.pathname === '/device')
				return url.pathname + url.search;
		} catch {}
	}
	return readDashboardReturnPath(value, origin);
}
