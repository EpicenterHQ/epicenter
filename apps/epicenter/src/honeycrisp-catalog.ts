import type {
	AgentToolCall,
	AgentToolDefinition,
	AgentToolOutcome,
	ToolCatalog,
} from '@epicenter/agent';
import { deleteHoneycrispFolder } from '@epicenter/honeycrisp';
import type { HoneycrispData } from './workspace.ts';

const LIST_FOLDERS_TOOL: AgentToolDefinition = {
	name: 'folders_list',
	kind: 'query',
	description: 'List Honeycrisp folders',
	inputSchema: {
		type: 'object',
		properties: {},
		additionalProperties: false,
	},
};

const CREATE_FOLDER_TOOL: AgentToolDefinition = {
	name: 'folders_create',
	kind: 'mutation',
	description: 'Create a Honeycrisp folder',
	inputSchema: {
		type: 'object',
		properties: { name: { type: 'string' } },
		required: ['name'],
		additionalProperties: false,
	},
};

const DELETE_FOLDER_TOOL: AgentToolDefinition = {
	name: 'folders_delete',
	kind: 'mutation',
	description: 'Delete a folder and re-parent its notes to unfiled',
	inputSchema: {
		type: 'object',
		properties: { folderId: { type: 'string' } },
		required: ['folderId'],
		additionalProperties: false,
	},
};

/** Adapt Honeycrisp's async row operation to the Home host's tool boundary. */
export function createHoneycrispCatalog(
	workspace: HoneycrispData,
): ToolCatalog {
	async function resolve(call: AgentToolCall): Promise<AgentToolOutcome> {
		if (call.toolName === LIST_FOLDERS_TOOL.name) {
			const { rows, nonconforming } = await workspace.folders.scan();
			if (nonconforming.length > 0) {
				return {
					content: 'Some Honeycrisp folders do not conform to this release.',
					isError: true,
				};
			}
			return { content: JSON.stringify(rows), details: rows, isError: false };
		}
		if (call.toolName === CREATE_FOLDER_TOOL.name) {
			const name = readString(call.input, 'name');
			if (name === undefined) {
				return { content: 'A "name" string is required.', isError: true };
			}
			const folder = await workspace.folders.create({
				name,
				sortOrder: 0,
			});
			return {
				content: JSON.stringify(folder),
				details: folder,
				isError: false,
			};
		}
		if (call.toolName !== DELETE_FOLDER_TOOL.name) {
			return {
				content: `No Honeycrisp tool named "${call.toolName}".`,
				isError: true,
			};
		}
		const folderId = readFolderId(call.input);
		if (folderId === undefined) {
			return { content: 'A "folderId" string is required.', isError: true };
		}
		try {
			await deleteHoneycrispFolder(workspace, folderId);
			return { content: 'null', details: null, isError: false };
		} catch (cause) {
			return {
				content: cause instanceof Error ? cause.message : String(cause),
				isError: true,
			};
		}
	}

	return {
		definitions: () => [
			LIST_FOLDERS_TOOL,
			CREATE_FOLDER_TOOL,
			DELETE_FOLDER_TOOL,
		],
		resolve,
	};
}

function readFolderId(input: AgentToolCall['input']): string | undefined {
	return readString(input, 'folderId');
}

function readString(
	input: AgentToolCall['input'],
	key: string,
): string | undefined {
	if (input === null || typeof input !== 'object' || Array.isArray(input)) {
		return undefined;
	}
	const value = (input as Record<string, unknown>)[key];
	return typeof value === 'string' ? value : undefined;
}
