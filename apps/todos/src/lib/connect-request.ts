/**
 * Reopening Connect across a page load: signing in to Epicenter from Connect
 * leaves the page, and the list opens Connect once when it comes back, so the
 * person continues where they left off. Session storage, so it stays in this tab.
 */
const KEY = 'so.epicenter.todos.connect';

/** Ask the next list this tab shows to open Connect. */
export function requestConnect() {
	try {
		sessionStorage.setItem(KEY, '1');
	} catch {
		// Without session storage the person opens Connect again themselves.
	}
}

/** Whether Connect was asked for, read once. */
export function takeConnectRequest(): boolean {
	try {
		const asked = sessionStorage.getItem(KEY) !== null;
		sessionStorage.removeItem(KEY);
		return asked;
	} catch {
		return false;
	}
}
