/**
 * The page's root, chosen by its path. Each root is one variant of the
 * recorder with one store for the page's whole life (ADR-0700), and each
 * loads only what it uses:
 *
 * - `/online`: the online variant, the signed-in person's repository
 *   (`OnlineApp.svelte`). Only it signs in.
 * - `/auth/callback`: finishes a sign-in the online variant started, then
 *   loads the page it started from.
 * - Any other path (`/`): the local variant, this browser's files
 *   (`LocalApp.svelte`), opened here before it mounts. It never constructs
 *   the OAuth client.
 */
import { mount } from 'svelte';
import './app.css';

const target = document.getElementById('app') as HTMLElement;

if (location.pathname === '/auth/callback') {
	const { auth } = await import('./lib/auth.ts');
	const { data, error } = await auth.completeSignIn();
	if (error === null) location.replace(data.returnTo ?? '/online');
	else {
		target.textContent = `Sign-in failed: ${error.message} `;
		const back = Object.assign(document.createElement('a'), {
			href: '/online',
			textContent: 'Back',
		});
		target.append(back);
	}
} else if (location.pathname === '/online') {
	const { default: OnlineApp } = await import('./OnlineApp.svelte');
	mount(OnlineApp, { target });
} else {
	const [{ default: LocalApp }, { openDevice }, { recorder }] =
		await Promise.all([
			import('./LocalApp.svelte'),
			import('@epicenter/folder/browser'),
			import('./contract.ts'),
		]);
	// This page's one store; a browser that keeps no files still opens it.
	const device = await openDevice(recorder);
	if (device.error !== null)
		target.textContent = `The recorder could not open this browser's files: ${device.error.message}`;
	else mount(LocalApp, { target, props: { device: device.data } });
}
