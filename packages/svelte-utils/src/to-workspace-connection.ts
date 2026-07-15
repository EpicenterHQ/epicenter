import type { SyncAuthClient } from '@epicenter/auth';
import type { WorkspaceConnection } from '@epicenter/workspace';

/** Project one boot-time auth snapshot into the app's workspace connection. */
export function toWorkspaceConnection(
	auth: SyncAuthClient,
): WorkspaceConnection {
	const state = auth.state;
	if (state.status === 'signed-out') return { kind: 'local' };
	return {
		kind: 'server',
		baseURL: auth.deployment.baseURL,
		principalId: state.principalId,
		fetch: auth.fetch,
		openWebSocket: auth.openWebSocket,
		onReconnectSignal: auth.onStateChange,
	};
}
