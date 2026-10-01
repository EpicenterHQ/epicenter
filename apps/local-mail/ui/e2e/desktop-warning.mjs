/** Exercise the actual route and root dialog with a synthetic desktop auth port. */
export function desktopWarning() {
	return {
		name: 'mail-desktop-warning-evidence',
		transform(source, id) {
			if (!id.endsWith('/local-mail/ui/src/lib/platform/auth.browser.ts'))
				return;
			return (
				source.replace('export const auth =', 'const browserAuth =') +
				`
export const auth = new URLSearchParams(location.search).has('desktop-warning')
	? {
		...browserAuth,
		completeSignIn: undefined,
		async startSignIn() {
			globalThis.desktopSignInRequests = (globalThis.desktopSignInRequests ?? 0) + 1;
			return { data: undefined, error: null };
		},
	}
	: browserAuth;
`
			);
		},
	};
}
