import type { PrincipalId } from '@epicenter/identity';

const WORKSPACE_AUTHORITY_HASH_DOMAIN =
	'epicenter.workspace-authority-hash/1' as const;

/** The one owner whose live state this runtime opens. */
export type WorkspaceAuthority =
	| { readonly kind: 'local' }
	| {
			readonly kind: 'server';
			readonly baseURL: string;
			readonly principalId: PrincipalId;
	  };

export type ServerWorkspaceAuthority = Extract<
	WorkspaceAuthority,
	{ kind: 'server' }
>;

/** Canonical deployment identity used by local replica partitioning. */
export function normalizeWorkspaceServerBaseURL(baseURL: string): string {
	const url = new URL(baseURL);
	if (url.protocol !== 'http:' && url.protocol !== 'https:') {
		throw new Error('Workspace server base URL must use HTTP or HTTPS');
	}
	if (url.username !== '' || url.password !== '') {
		throw new Error('Workspace server base URL must not contain credentials');
	}
	if (url.search !== '' || url.hash !== '') {
		throw new Error(
			'Workspace server base URL must not contain search or hash',
		);
	}
	url.pathname = url.pathname.replace(/\/+$/, '') || '/';
	return url.href;
}

/** Validate and own the boot-time authority value before deriving storage. */
export function normalizeWorkspaceAuthority(
	authority: WorkspaceAuthority,
): WorkspaceAuthority {
	if (authority.kind === 'local') return Object.freeze({ kind: 'local' });
	if (authority.kind !== 'server') {
		throw new Error('Workspace authority kind must be local or server');
	}
	if (authority.principalId.trim() === '') {
		throw new Error('Workspace server principal id must not be empty');
	}
	return Object.freeze({
		kind: 'server',
		baseURL: normalizeWorkspaceServerBaseURL(authority.baseURL),
		principalId: authority.principalId,
	});
}

/** Internal non-secret partition hash for one normalized server authority. */
export async function workspaceAuthorityHash(
	authority: ServerWorkspaceAuthority,
): Promise<string> {
	const normalized = normalizeWorkspaceAuthority(
		authority,
	) as ServerWorkspaceAuthority;
	const input = new TextEncoder().encode(
		`${WORKSPACE_AUTHORITY_HASH_DOMAIN}\u0000${normalized.baseURL}\u0000${normalized.principalId}`,
	);
	const digest = await crypto.subtle.digest('SHA-256', input);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
}
