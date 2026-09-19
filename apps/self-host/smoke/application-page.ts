/** Disposable browser consumer of the same startup and callback API as store apps. */
import { createBrowserRedirectAuth, selfHostedServer } from '@epicenter/auth';
import { API_ROUTES } from '@epicenter/constants/api-routes';

const auth = createBrowserRedirectAuth({
	appId: 'self-host-smoke',
	server: selfHostedServer(import.meta.env.VITE_EPICENTER_SERVER),
});
const output = document.querySelector('output')!;
const signIn = document.querySelector<HTMLButtonElement>('#sign-in')!;
signIn.onclick = async () => {
	const result = await auth.startSignIn({ reauthenticate: true });
	if (result?.error) throw result.error;
};
const check = document.querySelector<HTMLButtonElement>('#check')!;
check.onclick = async () => {
	const state = auth.getState();
	if (!state || state.status === 'signed-out') throw new Error('No Account');
	const response = await state.account.fetch(API_ROUTES.session.pattern);
	output.textContent = `${response.status}:${state.account.principalId}`;
};
if (location.pathname === '/auth/callback') {
	const result = await auth.completeSignIn();
	if (result.error) throw result.error;
	location.replace('/');
} else {
	const state = auth.getState();
	output.textContent =
		state && state.status !== 'signed-out'
			? state.account.principalId
			: 'signed-out';
}
