/** Test-only address and admission proposal. No production caller imports this. */
import { isAppId } from '@epicenter/constants/app-id';
import { normalizeInstanceServer } from '../../../auth/src/instance-server.js';

export function deployment(origin: string, kind: 'cloud' | 'self-host') {
	if (kind === 'cloud') {
		if (origin !== 'https://api.epicenter.so')
			throw new Error('Reserved Cloud authority');
		return { origin, kind, authorityId: 'epicenter-api' };
	}
	const normalized = normalizeInstanceServer(origin);
	return {
		origin: normalized.baseURL,
		kind,
		authorityId: normalized.authorityId,
	};
}

/** Named identities stand in for real sessions only in this experiment. */
export function authorize(
	server: ReturnType<typeof deployment>,
	bearer: string | null,
	appId: string,
	scope: string,
	owner?: string,
) {
	if (bearer !== 'alice' && bearer !== 'bob')
		throw new Error('Unauthenticated');
	if (!isAppId(appId)) throw new Error('Invalid app');
	if (owner !== undefined)
		throw new Error('Personal owner is derived, never supplied');
	if (scope !== 'personal' && scope !== 'shared')
		throw new Error('Invalid scope');
	if (scope === 'shared' && server.kind === 'cloud')
		throw new Error('Shared unavailable');
	const actor = { authorityId: server.authorityId, principalId: bearer };
	const remote =
		server.kind === 'cloud'
			? `principals/${bearer}`
			: `apps/${appId}/libraries/${scope === 'personal' ? `personal/${bearer}` : 'shared'}`;
	const replica =
		server.kind === 'cloud'
			? `epicenter/${appId}/accounts/${actor.authorityId}/${bearer}`
			: `epicenter/${appId}/accounts/${actor.authorityId}/${bearer}/libraries/${scope}`;
	return {
		actor,
		remote: { origin: server.origin, root: remote },
		replica,
		document: (dataId: string, generation: number) =>
			`${replica}/data/${dataId}/${generation}`,
		blob: (blobId: string) => `${replica}/blobs/${blobId}`,
		sqlite: (name: string) => [
			appId,
			'account',
			actor.authorityId,
			bearer,
			...(server.kind === 'cloud' ? [] : [scope]),
			name,
		],
		recording: replica,
		lock: `epicenter.store:library:${JSON.stringify([appId, actor.authorityId, bearer, ...(server.kind === 'cloud' ? [] : [scope])])}`,
	};
}
