export const BROWSER_WORKSPACE_RUNTIME_PROTOCOL =
	'epicenter.browser-workspace-runtime/1' as const;

export type BrowserWorkspaceWorkerInitialization =
	| {
			protocol: typeof BROWSER_WORKSPACE_RUNTIME_PROTOCOL;
			type: 'initialize';
			workspaceKind: 'standalone';
			databaseName: string;
	  }
	| {
			protocol: typeof BROWSER_WORKSPACE_RUNTIME_PROTOCOL;
			type: 'initialize';
			workspaceKind: 'replica';
			databaseName: string;
			syncPort: MessagePort;
	  };

export function parseBrowserWorkspaceWorkerInitialization(
	value: unknown,
): BrowserWorkspaceWorkerInitialization {
	if (
		typeof value !== 'object' ||
		value === null ||
		(value as { protocol?: unknown }).protocol !==
			BROWSER_WORKSPACE_RUNTIME_PROTOCOL ||
		(value as { type?: unknown }).type !== 'initialize' ||
		((value as { workspaceKind?: unknown }).workspaceKind !== 'standalone' &&
			(value as { workspaceKind?: unknown }).workspaceKind !== 'replica') ||
		typeof (value as { databaseName?: unknown }).databaseName !== 'string'
	) {
		throw new Error('Invalid browser workspace Worker initialization');
	}
	const message = value as Record<string, unknown>;
	if (!/^[A-Za-z0-9._-]+\.sqlite3$/.test(message.databaseName as string)) {
		throw new Error('Invalid browser workspace database name');
	}
	if (message.workspaceKind === 'standalone') {
		if (
			Object.keys(message).sort().join(',') !==
			'databaseName,protocol,type,workspaceKind'
		) {
			throw new Error('Invalid browser standalone workspace initialization');
		}
		return value as BrowserWorkspaceWorkerInitialization;
	}
	if (
		Object.keys(message).sort().join(',') !==
			'databaseName,protocol,syncPort,type,workspaceKind' ||
		typeof message.syncPort !== 'object' ||
		message.syncPort === null ||
		typeof (message.syncPort as { postMessage?: unknown }).postMessage !==
			'function'
	) {
		throw new Error('Invalid browser workspace replica initialization');
	}
	return value as BrowserWorkspaceWorkerInitialization;
}
