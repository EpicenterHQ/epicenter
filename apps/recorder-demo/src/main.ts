import { mount } from 'svelte';
import App from './App.svelte';
import { auth } from './lib/auth.ts';
import './app.css';

const target = document.getElementById('app') as HTMLElement;

// The sign-in callback finishes, then loads the page it started from, so
// the app always starts with one account for the page's whole life.
if (location.pathname === '/auth/callback') {
	const { data, error } = await auth.completeSignIn();
	if (error === null) location.replace(data.returnTo ?? '/');
	else {
		target.textContent = `Sign-in failed: ${error.message} `;
		const back = Object.assign(document.createElement('a'), {
			href: '/',
			textContent: 'Back',
		});
		target.append(back);
	}
} else {
	mount(App, { target });
}
