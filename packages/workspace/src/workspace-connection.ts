import type { PrincipalId } from '@epicenter/identity';
import type {
	OnReconnectSignal,
	OpenWebSocketFn,
} from './document/open-collaboration.js';

export type WorkspaceFetch = (
	input: Request | string | URL,
	init?: RequestInit,
) => Promise<Response>;

/** The one boot-time choice every workspace-backed application receives. */
export type WorkspaceConnection =
	| { readonly kind: 'local' }
	| {
			readonly kind: 'server';
			readonly baseURL: string;
			readonly principalId: PrincipalId;
			readonly fetch: WorkspaceFetch;
			readonly openWebSocket: OpenWebSocketFn;
			readonly onReconnectSignal: OnReconnectSignal;
	  };
