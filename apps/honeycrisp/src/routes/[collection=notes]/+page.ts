import { resolve } from '$app/paths';
import { authStartup } from '#platform/auth';
import { redirect } from '@sveltejs/kit';

export function load() {
	if (authStartup.auth === null) redirect(307, resolve('/connect'));
}
