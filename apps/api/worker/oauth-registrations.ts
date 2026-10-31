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
	LOCAL_APPS,
	localUrl,
	resolveOAuthAudiences,
} from '@epicenter/constants/apps';
import type { FirstPartyClient } from '@epicenter/server';
import { isLocalDeployment } from './trusted-origins.js';

/** Each browser build signs in as its own app id; these are those ids. */
const BROWSER_APPS = [
	{ clientId: 'so.epicenter.todos', name: 'Todos', app: APPS.TODOS },
	{
		clientId: APPS.WHISPERING.id,
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
 * A browser build's client: consent skipped, target `*`, signing in back to
 * `/auth/callback` on each of `appOrigins`. It may ask for `offline_access`
 * only so one sign-in can mint an access token per audience: the callback
 * exchanges the code for one audience and refreshes once for each other, then
 * keeps the access tokens and no refresh token. The grant stays bound to the
 * authorization server's session (`offlineDetach` skips web clients).
 */
function browserClient(
	{
		clientId,
		name,
		resources,
	}: { clientId: string; name: string; resources: string[] },
	appOrigins: string[],
): FirstPartyClient {
	return {
		clientId,
		name,
		redirectUris: appOrigins.map((appOrigin) => `${appOrigin}/auth/callback`),
		grantTypes: ['authorization_code', 'refresh_token'],
		scopes: [
			'openid',
			'offline_access',
			'profile',
			'email',
			'ai',
			'folders:read',
			'folders:write',
		],
		resources,
		skipConsent: true,
		applicationType: 'web',
	};
}

/**
 * Every first-party client this deployment registers. The dashboard is not
 * one: it is the authorization server's own page and uses its session cookie.
 */
export function buildFirstPartyClients(origin: string): FirstPartyClient[] {
	const audiences = resolveOAuthAudiences(origin);
	const local = isLocalDeployment(origin);
	const firstPartyResources = [audiences.api, audiences.git];
	return [
		...BROWSER_APPS.map(({ clientId, name, app }) =>
			browserClient({ clientId, name, resources: firstPartyResources }, [
				app.url,
				...(local ? [localUrl(app)] : []),
			]),
		),
		// A local deployment also serves the apps that have no production
		// origin (a demo), at their dev origin only.
		...(local
			? Object.values(LOCAL_APPS).map((app) =>
					browserClient(
						{
							clientId: app.id,
							name: app.name,
							resources: firstPartyResources,
						},
						[localUrl(app)],
					),
				)
			: []),
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
		// Vocab's desktop program signs in only for hosted models and
		// dictation: its words are files in a folder Epicenter syncs, so it
		// asks for the API alone. A loopback redirect on any port (RFC 8252),
		// and the refresh token in that computer's keychain.
		{
			clientId: 'so.epicenter.vocab.desktop',
			name: 'Vocab',
			redirectUris: ['http://127.0.0.1/callback'],
			grantTypes: ['authorization_code', 'refresh_token'],
			scopes: ['openid', 'offline_access', 'profile', 'email', 'ai'],
			resources: [audiences.api],
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
