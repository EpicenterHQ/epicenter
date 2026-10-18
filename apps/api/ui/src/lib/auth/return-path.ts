import { readDashboardReturnPath } from '../dashboard/navigation.js';

/**
 * Where a plain sign-in continues: the `return` path an account page sent, or
 * `/dashboard`. Only those pages are accepted, so a link cannot steer a
 * signed-in browser anywhere else. A device code signs in through the
 * authorization request it resumes, not through `return`.
 */
export function readReturnPath(search: string, origin: string) {
	const values = new URLSearchParams(search).getAll('return');
	const value = values.length === 1 ? (values[0] ?? null) : null;
	return readDashboardReturnPath(value, origin);
}
