import { isAppId } from '@epicenter/constants/app-id';
import type { PrincipalId } from '@epicenter/principal';

/** Server-owned destination; the authenticated principal remains the request actor. */
export function libraryStoragePrefix(
	appId: string,
	library: 'personal' | 'shared',
	actor: PrincipalId,
): string {
	return library === 'shared'
		? `libraries/apps/${encodeURIComponent(appId)}/shared`
		: `libraries/apps/${encodeURIComponent(appId)}/personal/${encodeURIComponent(actor)}`;
}

/** Admission grants Shared only on deployments that explicitly offer it. */
export function resolveLibraryPrefix(
	appId: string | undefined,
	library: string | undefined,
	actor: PrincipalId,
	shared: boolean,
): string | undefined {
	if (
		!appId ||
		!isAppId(appId) ||
		(library !== 'personal' && library !== 'shared')
	)
		return;
	if (library === 'shared' && !shared) return;
	return libraryStoragePrefix(appId, library, actor);
}
