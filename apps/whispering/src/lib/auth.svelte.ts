import { fromAuth } from '@epicenter/auth/svelte';
import { authClient } from '#platform/auth';

const auth = authClient.auth ? fromAuth(authClient.auth) : null;

export function getAuth() {
	if (!auth) throw new Error('Application UI requires a valid auth startup.');
	return auth;
}
