import { fromAuth } from '@epicenter/auth/svelte';
import { authStartup } from './auth.js';

const auth = authStartup.auth ? fromAuth(authStartup.auth) : null;

export function getAuth() {
	if (!auth) throw new Error('Application UI requires a valid auth startup.');
	return auth;
}
