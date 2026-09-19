import { normalizeInstanceServer } from './instance-server.js';

/** Deployment-owned identity and capabilities. Never chosen from saved user state. */
export type AuthServer = {
	baseURL: string;
	authorityId: string;
	supportsShared: boolean;
	accountManagement: boolean;
};

export function epicenterCloud(baseURL: string): AuthServer {
	return {
		baseURL: new URL(baseURL).origin,
		authorityId: 'epicenter-api',
		supportsShared: false,
		accountManagement: true,
	};
}

export function selfHostedServer(origin: string): AuthServer {
	return {
		...normalizeInstanceServer(origin),
		supportsShared: true,
		accountManagement: false,
	};
}
