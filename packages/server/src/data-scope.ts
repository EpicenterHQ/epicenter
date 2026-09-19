import { isAppId } from '@epicenter/constants/app-id';
import type { PrincipalId } from '@epicenter/principal';

/** Server-owned destination for the authenticated principal's app data. */
export function dataStoragePrefix(appId: string, actor: PrincipalId): string {
	return `libraries/apps/${encodeURIComponent(appId)}/personal/${encodeURIComponent(actor)}`;
}

/** Only Personal app data is admitted. */
export function resolveDataPrefix(
	appId: string | undefined,
	scope: string | undefined,
	actor: PrincipalId,
): string | undefined {
	if (!appId || !isAppId(appId) || scope !== 'personal') return;
	return dataStoragePrefix(appId, actor);
}
