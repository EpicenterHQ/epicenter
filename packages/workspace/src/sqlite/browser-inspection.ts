import type { ApplicationDatabaseIdentityInspection } from './database.js';

export const WORKSPACE_INSPECTION_PROTOCOL =
	'epicenter.workspace-inspection/1' as const;

export type LocalWorkspaceInspection =
	| { status: 'absent' }
	| ApplicationDatabaseIdentityInspection;

export type WorkspaceInspectionCommand = {
	protocol: typeof WORKSPACE_INSPECTION_PROTOCOL;
	type: 'inspect';
	workspaceKind: 'standalone' | 'replica';
	databaseName: string;
};

export type WorkspaceInspectionEvent =
	| {
			protocol: typeof WORKSPACE_INSPECTION_PROTOCOL;
			type: 'result';
			workspaceKind: 'standalone' | 'replica';
			workspaceId: string;
			recordsDescriptor: string;
			recordsSchemaHash: string;
			inspection: LocalWorkspaceInspection;
	  }
	| {
			protocol: typeof WORKSPACE_INSPECTION_PROTOCOL;
			type: 'error';
			error: { name: string; message: string };
	  };

export function parseWorkspaceInspectionEvent(
	value: unknown,
): WorkspaceInspectionEvent {
	if (!isRecord(value) || value.protocol !== WORKSPACE_INSPECTION_PROTOCOL) {
		throw new Error('Invalid workspace inspection worker event');
	}
	if (value.type === 'error') {
		if (
			!hasExactKeys(value, ['error', 'protocol', 'type']) ||
			!isRecord(value.error) ||
			!hasExactKeys(value.error, ['message', 'name']) ||
			typeof value.error.name !== 'string' ||
			typeof value.error.message !== 'string'
		) {
			throw new Error('Invalid workspace inspection worker error');
		}
		return value as WorkspaceInspectionEvent;
	}
	if (
		value.type !== 'result' ||
		!hasExactKeys(value, [
			'inspection',
			'protocol',
			'recordsDescriptor',
			'recordsSchemaHash',
			'type',
			'workspaceId',
			'workspaceKind',
		]) ||
		(value.workspaceKind !== 'standalone' &&
			value.workspaceKind !== 'replica') ||
		typeof value.workspaceId !== 'string' ||
		typeof value.recordsDescriptor !== 'string' ||
		typeof value.recordsSchemaHash !== 'string' ||
		!isInspection(value.inspection)
	) {
		throw new Error('Invalid workspace inspection worker result');
	}
	return value as WorkspaceInspectionEvent;
}

export function parseWorkspaceInspectionCommand(
	value: unknown,
): WorkspaceInspectionCommand {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, [
			'databaseName',
			'protocol',
			'type',
			'workspaceKind',
		]) ||
		value.protocol !== WORKSPACE_INSPECTION_PROTOCOL ||
		value.type !== 'inspect' ||
		(value.workspaceKind !== 'standalone' &&
			value.workspaceKind !== 'replica') ||
		typeof value.databaseName !== 'string' ||
		!/^[A-Za-z0-9._-]+\.sqlite3$/.test(value.databaseName)
	) {
		throw new Error('Invalid workspace inspection worker command');
	}
	return value as WorkspaceInspectionCommand;
}

function isInspection(value: unknown): value is LocalWorkspaceInspection {
	if (!isRecord(value) || typeof value.status !== 'string') return false;
	switch (value.status) {
		case 'absent':
		case 'initialized':
			return hasExactKeys(value, ['status']);
		case 'invalid':
			return (
				hasExactKeys(value, ['reason', 'status']) &&
				typeof value.reason === 'string' &&
				value.reason.length > 0
			);
		default:
			return false;
	}
}

function hasExactKeys(
	value: Record<string, unknown>,
	expected: readonly string[],
): boolean {
	const keys = Object.keys(value).sort();
	return (
		keys.length === expected.length &&
		keys.every((key, index) => key === expected[index])
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
