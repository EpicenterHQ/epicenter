import { APPS, localUrl, prodOrigins } from '@epicenter/constants/apps';

/** Exact destinations allowed to receive a PKCE-bound code, never a session. */
export function buildSessionCallbacks(baseURL: string) {
	const origin = new URL(baseURL).origin;
	const hostname = new URL(origin).hostname;
	const local = ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
	return [
		'epicenter://auth/callback',
		// Local Mail has a development browser build and no hosted origin.
		...(local ? ['http://localhost:5177/auth/callback'] : []),
		// Outside /auth/*, which belongs to Better Auth on the issuer origin.
		`${origin}/session/callback`,
		...[APPS.HONEYCRISP, APPS.WHISPERING, APPS.VOCAB].flatMap((app) =>
			[...prodOrigins(app), ...(local ? [localUrl(app)] : [])].map(
				(appOrigin) => `${appOrigin}/auth/callback`,
			),
		),
	];
}
