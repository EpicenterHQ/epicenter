import { fromAuth } from '@epicenter/auth/svelte';
import { auth } from '#platform/auth';

const reactiveAuth = auth ? fromAuth(auth) : null;

export function getAuth() {
	if (!reactiveAuth)
		throw new Error('Application UI requires a valid auth startup.');
	return reactiveAuth;
}
