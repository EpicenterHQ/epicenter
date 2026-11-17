// Deployment-owned identity and registrations, separate from Worker handlers.
import type { OAuthAudiences } from '@epicenter/server';
export const HOME_ORIGIN =
	'https://epicenter-tasks-workers-prototype.epicenter.workers.dev';
export const HOME_LOCAL_ORIGIN = 'http://localhost:8799';
export const HOME_CLIENT = 'so.epicenter.home';
export const HOME_AGENT_CLIENT = 'so.epicenter.home.agent';
export const HOME_SCOPES = [
	'home:read',
	'home:source',
	'home:build',
	'home:run',
] as const;
export function homeExperimentEnabled(env: {
	HOSTED_HOMES_EXPERIMENT?: string;
}) {
	return env.HOSTED_HOMES_EXPERIMENT === 'on';
}
export function hostedAudiences(
	origin: string,
): OAuthAudiences & { homes: string } {
	const base = new URL(origin).origin;
	return { api: base, folders: base + '/folders', homes: base + '/homes' };
}
