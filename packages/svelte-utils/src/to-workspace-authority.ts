import type { AuthClient } from '@epicenter/auth';
import type { WorkspaceAuthority } from '@epicenter/workspace/sqlite';

/**
 * Project one boot-time auth snapshot into the workspace authority that owns
 * this runtime's local database.
 *
 * This reads `auth.state` once. A later principal change reloads the app so a
 * new runtime can select another authority; it never swaps databases in place.
 */
export function toWorkspaceAuthority(
	auth: Pick<AuthClient, 'deployment' | 'state'>,
): WorkspaceAuthority {
	const state = auth.state;
	if (state.status === 'signed-out') return { kind: 'local' };
	return {
		kind: 'server',
		baseURL: auth.deployment.baseURL,
		principalId: state.principalId,
	};
}
