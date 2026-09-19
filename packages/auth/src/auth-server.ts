import { normalizeInstanceServer } from './instance-server.js';

/** Deployment-owned network destination and local-data identity. Never chosen from saved user state. */
export type AuthServer = {
	baseURL: string;
	authorityId: string;
};

export function epicenterCloud(baseURL: string): AuthServer {
	return {
		baseURL: new URL(baseURL).origin,
		authorityId: 'epicenter-api',
	};
}

export function selfHostedServer(origin: string): AuthServer {
	return normalizeInstanceServer(origin);
}
