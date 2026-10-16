/**
 * The authorization server's registrations for this deployment (ADR-0549):
 * its token audiences and its first-party clients. They name Epicenter's own
 * origins and app ids, so they live in `apps/api`, beside the trusted origins,
 * not in the shared library.
 *
 * The deployment names the authority (ADR-0326). Its audiences come from
 * `resolveOAuthAudiences` in `@epicenter/constants/apps`, which the
 * `epicenter` CLI reads too.
 */
import {
	APPS,
	localUrl,
	prodOrigins,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import type { FirstPartyClient } from '@epicenter/server';

function isLoopback(origin: string) {
	return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(origin).hostname);
}

/**
 * Each browser build signs in as its own app id. Installed apps read their id
 * from `epicenter.app.json` (ADR-0560); these are those ids.
 */
const BROWSER_APPS = [
	{ clientId: 'so.epicenter.todos', name: 'Todos', app: APPS.TODOS },
	{
		clientId: 'so.epicenter.whispering',
		name: 'Whispering',
		app: APPS.WHISPERING,
	},
	{
		clientId: 'so.epicenter.honeycrisp',
		name: 'Honeycrisp',
		app: APPS.HONEYCRISP,
	},
	{ clientId: 'so.epicenter.capture', name: 'Capture', app: APPS.CAPTURE },
	{ clientId: APPS.VOCAB.id, name: 'Vocab', app: APPS.VOCAB },
	{ clientId: APPS.ZHONGWEN.id, name: 'Zhongwen', app: APPS.ZHONGWEN },
] as const;

/**
 * Every first-party client this deployment registers. The dashboard is not
 * one: it is the authorization server's own page and uses its session cookie.
 */
export function buildFirstPartyClients(origin: string): FirstPartyClient[] {
	const audiences = resolveOAuthAudiences(origin);
	const local = isLoopback(origin);
	const firstPartyResources = [audiences.api, audiences.git];
	return [
		// A browser build: one access token per origin, no refresh token,
		// consent skipped, target `*`.
		...BROWSER_APPS.map(
			({ clientId, name, app }): FirstPartyClient => ({
				clientId,
				name,
				redirectUris: [
					...prodOrigins(app),
					...(local ? [localUrl(app)] : []),
				].map((appOrigin) => `${appOrigin}/auth/callback`),
				grantTypes: ['authorization_code'],
				scopes: [
					'openid',
					'profile',
					'email',
					'ai',
					'folders:read',
					'folders:write',
				],
				resources: firstPartyResources,
				skipConsent: true,
				applicationType: 'web',
			}),
		),
		// The desktop app signs in through a loopback redirect on any port
		// (RFC 8252), and holds the only refresh token a first-party app keeps.
		{
			clientId: 'so.epicenter',
			name: 'Epicenter',
			redirectUris: ['http://127.0.0.1/callback'],
			grantTypes: ['authorization_code', 'refresh_token'],
			scopes: [
				'openid',
				'offline_access',
				'profile',
				'ai',
				'folders:read',
				'folders:write',
			],
			resources: firstPartyResources,
			skipConsent: true,
			applicationType: 'native',
		},
		// The CLI and the agents on the person's machine: the device grant
		// only, approved on the device approval page every time.
		{
			clientId: 'so.epicenter.cli',
			name: 'Epicenter CLI',
			redirectUris: [],
			grantTypes: [
				'urn:ietf:params:oauth:grant-type:device_code',
				'refresh_token',
			],
			// `openid` lets `epicenter auth status` read who approved the grant
			// from userinfo; the client still gets no ID token, being public.
			scopes: [
				'openid',
				'offline_access',
				'profile',
				'ai',
				'folders:read',
				'folders:write',
			],
			resources: firstPartyResources,
			skipConsent: false,
			applicationType: 'native',
		},
	];
}
