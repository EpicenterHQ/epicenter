import { redirect } from '@sveltejs/kit';

// `/` opens your home: every owner's home repository is named `home`, and `me` is you.
export function load() {
	redirect(307, '/me/home');
}
