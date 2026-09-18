/** Disposable browser consumer of the same startup and callback API as store apps. */
import { createBrowserAuth, isCallbackAuthClient } from '@epicenter/auth';

const startup = createBrowserAuth({
	appId: 'self-host-smoke',
	baseURL: 'https://cloud.invalid',
});
const output = document.querySelector('output')!;
const issuer = document.body.dataset.issuer!;
const connect = document.querySelector<HTMLButtonElement>('#connect')!;
connect.onclick = async () => {
	const result = await startup.connectInstance({ url: issuer });
	if (result.error) throw result.error;
};
const signIn = document.querySelector<HTMLButtonElement>('#sign-in')!;
signIn.onclick = async () => {
	const result = await startup.auth?.startSignIn?.({ reauthenticate: true });
	if (result?.error) throw result.error;
};
const check = document.querySelector<HTMLButtonElement>('#check')!;
check.onclick = async () => {
	const state = startup.auth?.getState();
	if (!state || state.status === 'signed-out') throw new Error('No Account');
	const response = await state.account.fetch('/api/session');
	output.textContent = `${response.status}:${state.account.principalId}`;
};
if (location.pathname === '/auth/callback') {
	const auth = startup.auth;
	if (!auth || !isCallbackAuthClient(auth))
		throw new Error('Callback unavailable');
	const result = await auth.completeSignIn();
	if (result.error) throw result.error;
	location.replace('/');
} else if (location.search === '?connect' && startup.selectedServer) {
	const result = await startup.auth?.startSignIn?.();
	if (result?.error) throw result.error;
} else {
	const state = startup.auth?.getState();
	output.textContent =
		state && state.status !== 'signed-out'
			? state.account.principalId
			: 'signed-out';
}
