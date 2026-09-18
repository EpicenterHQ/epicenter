import { isAppId } from '@epicenter/constants/app-id';
import type { PrincipalId } from '@epicenter/principal';

/** Server-owned destination; the authenticated principal remains the request actor. */
export function dataStoragePrefix(
	appId: string,
	scope: 'personal' | 'shared',
	actor: PrincipalId,
): string {
	return scope === 'shared'
		? `libraries/apps/${encodeURIComponent(appId)}/shared`
		: `libraries/apps/${encodeURIComponent(appId)}/personal/${encodeURIComponent(actor)}`;
}

/** Admission grants Shared only on deployments that explicitly offer it. */
export function resolveDataPrefix(
	appId: string | undefined,
	scope: string | undefined,
	actor: PrincipalId,
	shared: boolean,
): string | undefined {
	if (!appId || !isAppId(appId) || (scope !== 'personal' && scope !== 'shared'))
		return;
	if (scope === 'shared' && !shared) return;
	return dataStoragePrefix(appId, scope, actor);
}
