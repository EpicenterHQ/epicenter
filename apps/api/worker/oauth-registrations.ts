/** First-party OAuth clients and their redirect URLs for this deployment. */
import type { FirstPartyClient } from '@epicenter/server';
import { BROWSER_APP_ORIGINS } from '../origins.js';
import { isLocalDeployment } from './trusted-origins.js';

const BROWSER_CLIENTS = [
	{
		clientId: 'so.epicenter.todos',
		name: 'Todos',
		origins: BROWSER_APP_ORIGINS.todos,
	},
	{
		clientId: 'so.epicenter.whispering',
		name: 'Whispering',
		origins: BROWSER_APP_ORIGINS.whispering,
	},
	{
		clientId: 'so.epicenter.capture',
		name: 'Capture',
		origins: BROWSER_APP_ORIGINS.capture,
	},
	{
		clientId: 'so.epicenter.vocab',
		name: 'Vocab',
		origins: BROWSER_APP_ORIGINS.vocab,
	},
	{
		clientId: 'com.bradenwong.zhongwen',
		name: 'Zhongwen',
		origins: BROWSER_APP_ORIGINS.zhongwen,
	},
] as const;

const NATIVE_CLIENTS = [
	{ clientId: 'so.epicenter.whispering.native', name: 'Whispering' },
	{ clientId: 'so.epicenter.vocab.native', name: 'Vocab' },
	{ clientId: 'so.epicenter', name: 'Epicenter' },
] as const;

/** The dashboard uses the authorization server's own session cookie. */
export function buildFirstPartyClients(origin: string): FirstPartyClient[] {
	const local = isLocalDeployment(origin);
	const resources = [origin];
	const grantTypes = ['authorization_code', 'refresh_token'] as const;
	const scopes = [
		'openid',
		'offline_access',
		'profile',
		'email',
		'ai',
	] as const;
	return [
		...BROWSER_CLIENTS.map(
			({ clientId, name, origins }): FirstPartyClient => ({
				clientId,
				name,
				redirectUris: (local ? origins : origins.slice(0, 1)).map(
					(appOrigin) => `${appOrigin}/auth/callback`,
				),
				grantTypes: [...grantTypes],
				scopes: [...scopes],
				resources,
				skipConsent: true,
				applicationType: 'web',
			}),
		),
		...NATIVE_CLIENTS.map(
			(client): FirstPartyClient => ({
				...client,
				// RFC 8252 allows the loopback listener to choose its own port.
				redirectUris: ['http://127.0.0.1/callback'],
				grantTypes: [...grantTypes],
				scopes: [...scopes],
				resources,
				skipConsent: true,
				applicationType: 'native',
			}),
		),
		// The CLI uses the device grant and asks for consent each time.
		{
			clientId: 'so.epicenter.cli',
			name: 'Epicenter CLI',
			redirectUris: [],
			grantTypes: [
				'urn:ietf:params:oauth:grant-type:device_code',
				'refresh_token',
			],
			scopes: ['openid', 'offline_access', 'profile', 'ai'],
			resources,
			skipConsent: false,
			applicationType: 'native',
		},
	];
}
