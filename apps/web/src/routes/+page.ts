import { redirect } from '@sveltejs/kit';

// `/` is you (ADR-0693): your repositories, installed apps, storage and account.
export function load() {
	redirect(307, '/me');
}
