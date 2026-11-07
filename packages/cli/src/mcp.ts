/**
 * `epicenter mcp [<dir> ...] [--all]` (ADR-0799, ADR-0800, ADR-0819,
 * ADR-0827): Epicenter served to an agent over the Model Context Protocol,
 * on stdin and stdout, by the official TypeScript SDK's low-level `Server`.
 *
 * Its tools are rendered from the same descriptions as the commands
 * (`operations.ts`): every platform operation, with its input and output
 * schemas, run by the same code. Beside them, for each folder it reaches
 * (those named, or every folder in the Epicenter folder with `--all`),
 * tools derived from the collections its `epicenter.json` declares:
 *
 * | Tool | Input | Does |
 * | --- | --- | --- |
 * | `<folder>_<collection>_query` | `{ where?, limit? }` | the items whose fields equal `where`, without bodies |
 * | `<folder>_<collection>_get` | the placeholders | one note: its fields and body |
 * | `<folder>_<collection>_set` | the placeholders, `fields`, `remove?` | a note's fields set, the rest kept |
 * | `<folder>_<collection>_write` | the placeholders, `body`, `fields?` | a note's body written |
 *
 * `get`, `set`, and `write` are a note collection's; a file collection has
 * `query` alone. Each goes through the folder (`openFolder`), as an app's
 * write does: in house style, over what it read, merging a body changed
 * since, and a field that does not fit the contract is refused before
 * anything is written. The tools are read again from each `epicenter.json`
 * whenever an agent lists them.
 *
 * It is an Epicenter program, so it keeps the folders it writes in sync
 * (`keepEverySynced`, limited to them): after a burst of its writes, every
 * few seconds while it runs, and once more as it ends. Signed out, it
 * writes and does not sync, and says so on stderr.
 *
 * Stdout is the protocol's channel: nothing else is written there. What a
 * person reads goes to stderr.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import {
	CallToolRequestSchema,
	type CallToolResult,
	ErrorCode,
	ListToolsRequestSchema,
	McpError,
	type Tool,
} from '@modelcontextprotocol/sdk/types.js';
import {
	CONTRACT_PATH,
	type CompiledCollection,
	type Contract,
	compileContract,
} from '@epicenter/definition/contract';
import { openFolder } from '@epicenter/folder';
import type { Folder, FolderFiles, FolderNotes } from '@epicenter/folder/core';
import { directory } from '@epicenter/folder/node';
import {
	type EpicenterRoot,
	firstPartyApps,
	type KeptFolders,
	keepEverySynced,
	type LocalFolder,
} from '@epicenter/folder/platform';
import { Value } from 'typebox/value';
import { Err, Ok, type Result } from 'wellcrafted/result';
import packageJson from '../package.json' with { type: 'json' };
import { authContext } from './auth.ts';
import { folderNameIn, homeRoot } from './folder-commands.ts';
import type { Operation } from './operation.ts';
import { OPERATIONS } from './operations.ts';
import { EXIT, writeErr } from './output.ts';
import { signedInNow } from './sync/account.ts';

/** Which folders the server reaches: those named, or every one. */
export type Reach = { names: ReadonlySet<string> } | { all: true };

/** A plain JSON Schema object, as a tool's input or output schema. */
type JsonObjectSchema = {
	type: 'object';
	properties?: Record<string, object>;
	required?: string[];
	[key: string]: unknown;
};

/** A schema as JSON: TypeBox's own symbol keys dropped. */
const plain = (schema: object) =>
	JSON.parse(JSON.stringify(schema)) as JsonObjectSchema;

/** What a tool answers: its structured content, or why it failed. */
type ToolAnswer = Result<Record<string, unknown>, string>;

/** One tool derived from a folder's contract. */
type DerivedTool = {
	tool: Tool;
	run(args: Record<string, unknown>): Promise<ToolAnswer>;
};

/** `Notes and things` as a tool name's prefix: `notes-and-things`. */
const slugOf = (name: string) =>
	name
		.normalize('NFKD')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '') || 'folder';

/** The folders the server reaches now, as the Epicenter folder lists them. */
async function reached(
	root: EpicenterRoot,
	reach: Reach,
): Promise<Result<LocalFolder[], string>> {
	const listed = await root.list();
	if (listed.error !== null) return Err(listed.error.message);
	return Ok(
		listed.data.folders.filter(
			({ name }) => 'all' in reach || reach.names.has(name),
		),
	);
}

const decoder = new TextDecoder();

/** The contract in `local`'s `epicenter.json`, as the folder opens it, with its text; or null. */
async function contractOf(local: LocalFolder) {
	const read = await local.store.read([CONTRACT_PATH]);
	const [file] = read.data ?? [];
	if (file === undefined || 'gone' in file) return null;
	const text = decoder.decode(file.bytes);
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof parsed !== 'object' || parsed === null) return null;
	// A contract is its collections; `$id` and other keys an app keeps are not the folder's.
	const {
		title,
		description,
		collections = {},
	} = parsed as Record<string, unknown>;
	const contract = {
		...(typeof title === 'string' ? { title } : {}),
		...(typeof description === 'string' ? { description } : {}),
		collections,
	} as Contract;
	const compiled = compileContract(contract);
	if (compiled.error !== null) return null;
	return { text, contract, compiled: compiled.data };
}

/** The folders opened for the tools, by path, kept while their contract stays. */
type Opened = { text: string; folder: Folder<Contract> };

/**
 * The tools derived from the folders the server reaches, by name, each
 * opening its folder when first called. `wrote` hears each folder a tool
 * wrote, by its path.
 */
function derivedTools({
	root,
	reach,
	opened,
	wrote,
}: {
	root: EpicenterRoot;
	reach: Reach;
	opened: Map<string, Opened>;
	wrote: (path: string) => void;
}) {
	/** The folder at `local`, opened over its contract, again when its contract changed. */
	const folderAt = (local: LocalFolder, text: string, contract: Contract) => {
		const kept = opened.get(local.path);
		if (kept !== undefined && kept.text === text) return kept.folder;
		kept?.folder[Symbol.dispose]();
		const folder = openFolder(contract, directory(local.path));
		opened.set(local.path, { text, folder });
		return folder;
	};

	return async (): Promise<Map<string, DerivedTool>> => {
		const tools = new Map<string, DerivedTool>();
		const folders = await reached(root, reach);
		if (folders.error !== null) return tools;
		for (const local of folders.data) {
			const found = await contractOf(local);
			if (found === null) continue;
			const { text, contract, compiled } = found;
			const slug = slugOf(local.name);
			for (const collection of compiled.collections) {
				const open = () => folderAt(local, text, contract);
				for (const derived of collectionTools({
					local,
					collection,
					declared: contract.collections[collection.name]?.fields ?? {},
					open,
					wrote: () => wrote(local.path),
				})) {
					let name = `${slug}_${collection.name}_${derived.verb}`.slice(-64);
					for (let n = 2; tools.has(name); n++)
						name = `${slug}-${n}_${collection.name}_${derived.verb}`.slice(-64);
					tools.set(name, {
						tool: { ...derived.tool, name },
						run: derived.run,
					});
				}
			}
		}
		return tools;
	};
}

/** The placeholders `args` gives, each a non-empty string, or which is missing. */
function placeholdersOf(
	collection: CompiledCollection,
	args: Record<string, unknown>,
): Result<Record<string, string>, string> {
	const out: Record<string, string> = {};
	for (const param of collection.template.params) {
		const value = args[param];
		if (typeof value !== 'string' || value === '')
			return Err(`${param} is needed, as a non-empty string`);
		out[param] = value;
	}
	return Ok(out);
}

/** Why `fields` do not fit `collection`, naming each field; null when they do. */
function misfit(
	collection: CompiledCollection,
	fields: Record<string, unknown>,
): string | null {
	const issues = collection
		.checkFields(fields)
		.filter(({ field }) => Object.hasOwn(fields, field));
	return issues.length === 0
		? null
		: issues.map(({ message }) => message).join('; ');
}

/** Whether `item` holds every value `where` names. */
const matches = (
	item: Record<string, unknown>,
	where: Record<string, unknown>,
) =>
	Object.entries(where).every(
		([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value),
	);

/** A note without its body, as a query lists it. */
const withoutBody = ({ body: _, ...rest }: Record<string, unknown>) => rest;

/** The tools of one collection: `query`, and for notes `get`, `set`, and `write`. */
function collectionTools({
	local,
	collection,
	declared,
	open,
	wrote,
}: {
	local: LocalFolder;
	collection: CompiledCollection;
	declared: Record<string, object>;
	open: () => Folder<Contract>;
	wrote: () => void;
}): { verb: string; tool: Omit<Tool, 'name'>; run: DerivedTool['run'] }[] {
	const where = `${collection.name} in the folder ${local.name} (${collection.template.source})`;
	const placeholders = Object.fromEntries(
		collection.template.params.map((param) => [
			param,
			{
				type: 'string',
				description: `{${param}} in ${collection.template.source}`,
			},
		]),
	);
	const required = [...collection.template.params];
	const fields: JsonObjectSchema = {
		type: 'object',
		properties: declared as Record<string, object>,
		description: `Fields of ${collection.name}, each as its contract declares it.`,
	};
	const notes = () =>
		(
			open() as unknown as Record<
				string,
				FolderNotes<Contract['collections'][string]>
			>
		)[collection.name] as FolderNotes<Contract['collections'][string]>;
	const files = () =>
		(
			open() as unknown as Record<
				string,
				FolderFiles<Contract['collections'][string]>
			>
		)[collection.name] as FolderFiles<Contract['collections'][string]>;

	/** The note `args` names, read from the folder now, or null. */
	const noteAt = async (args: Record<string, string>) => {
		const listed = await notes().list();
		if (listed.error !== null) return Err(listed.error.message);
		const item = listed.data.items.find((one) =>
			matches(one as Record<string, unknown>, args),
		);
		return Ok((item as Record<string, unknown> | undefined) ?? null);
	};

	const query = {
		verb: 'query',
		tool: {
			title: `Query ${collection.name}`,
			description: `List the ${collection.kind === 'note' ? 'notes' : 'files'} of ${where}${collection.kind === 'note' ? ', without their bodies, and the notes that do not read' : ''}. \`where\` keeps those whose ${collection.kind === 'note' ? 'fields and placeholders' : 'placeholders'} equal its values.`,
			inputSchema: {
				type: 'object' as const,
				properties: {
					where: {
						type: 'object',
						description: 'Values each item must hold, by field or placeholder.',
					},
					limit: { type: 'integer', minimum: 1, maximum: 1000 },
				},
			},
			outputSchema: {
				type: 'object' as const,
				properties: {
					items: { type: 'array', items: { type: 'object' } },
					invalid: { type: 'array', items: { type: 'object' } },
				},
				required: ['items'],
			},
			annotations: { readOnlyHint: true },
		},
		async run(args: Record<string, unknown>): Promise<ToolAnswer> {
			const filter =
				typeof args.where === 'object' && args.where !== null
					? (args.where as Record<string, unknown>)
					: {};
			const limit =
				typeof args.limit === 'number' ? args.limit : Number.POSITIVE_INFINITY;
			if (collection.kind === 'file') {
				const listed = await files().list();
				if (listed.error !== null) return Err(listed.error.message);
				return Ok({
					items: listed.data.items
						.filter((item) => matches(item as Record<string, unknown>, filter))
						.slice(0, limit),
				});
			}
			const listed = await notes().list();
			if (listed.error !== null) return Err(listed.error.message);
			return Ok({
				items: listed.data.items
					.filter((item) => matches(item as Record<string, unknown>, filter))
					.slice(0, limit)
					.map((item) => withoutBody(item as Record<string, unknown>)),
				invalid: listed.data.invalid.map(({ text: _, ...rest }) => rest),
			});
		},
	};
	if (collection.kind === 'file') return [query];

	const item = {
		type: 'object' as const,
		properties: {
			item: {
				type: ['object', 'null'],
				description:
					'The note: its placeholders, fields, and body; null when none is there.',
			},
		},
		required: ['item'],
	};

	const get = {
		verb: 'get',
		tool: {
			title: `Read a ${collection.name} note`,
			description: `Read one note of ${where}: its fields and its body.`,
			inputSchema: {
				type: 'object' as const,
				properties: placeholders,
				required,
			},
			outputSchema: item,
			annotations: { readOnlyHint: true },
		},
		async run(args: Record<string, unknown>): Promise<ToolAnswer> {
			const named = placeholdersOf(collection, args);
			if (named.error !== null) return named;
			const found = await noteAt(named.data);
			if (found.error !== null) return found;
			return Ok({ item: found.data });
		},
	};

	/** Write `changes` to the note `args` names, and answer the note as it is then. */
	const writeNote = async (
		args: Record<string, unknown>,
		changes: Record<string, unknown>,
	): Promise<ToolAnswer> => {
		const named = placeholdersOf(collection, args);
		if (named.error !== null) return named;
		const { body: _, ...given } = changes;
		const problem = misfit(collection, given);
		if (problem !== null) return Err(problem);
		const path = collection.pathOf(named.data);
		if (path.error !== null) return Err(path.error.message);
		try {
			await notes().set(named.data as never, changes as never);
		} catch (cause) {
			return Err(cause instanceof Error ? cause.message : String(cause));
		}
		wrote();
		const found = await noteAt(named.data);
		if (found.error !== null) return found;
		return Ok({ item: found.data });
	};

	const set = {
		verb: 'set',
		tool: {
			title: `Set fields of a ${collection.name} note`,
			description: `Set fields of one note of ${where}, keeping its other fields and its body; the note is made when none is there. \`remove\` names fields to take out.`,
			inputSchema: {
				type: 'object' as const,
				properties: {
					...placeholders,
					fields,
					remove: { type: 'array', items: { type: 'string' } },
				},
				required: [...required, 'fields'],
			},
			outputSchema: item,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
			},
		},
		run(args: Record<string, unknown>) {
			const given =
				typeof args.fields === 'object' && args.fields !== null
					? (args.fields as Record<string, unknown>)
					: {};
			const removed = Array.isArray(args.remove)
				? (args.remove as unknown[]).filter(
						(key): key is string => typeof key === 'string',
					)
				: [];
			if ('body' in given)
				return Promise.resolve(
					Err(
						`body is not a field; write it with the ${collection.name} write tool`,
					),
				);
			return writeNote(args, {
				...given,
				...Object.fromEntries(removed.map((key) => [key, undefined])),
			});
		},
	};

	const write = {
		verb: 'write',
		tool: {
			title: `Write a ${collection.name} note's body`,
			description: `Write the body of one note of ${where}, with any fields given, keeping its other fields; the note is made when none is there. A body changed since it was read merges by lines.`,
			inputSchema: {
				type: 'object' as const,
				properties: {
					...placeholders,
					body: {
						type: 'string',
						description: 'The Markdown below the front matter.',
					},
					fields,
				},
				required: [...required, 'body'],
			},
			outputSchema: item,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
			},
		},
		run(args: Record<string, unknown>) {
			if (typeof args.body !== 'string')
				return Promise.resolve(Err('body is needed, as a string'));
			const given =
				typeof args.fields === 'object' && args.fields !== null
					? (args.fields as Record<string, unknown>)
					: {};
			return writeNote(args, { ...given, body: args.body });
		},
	};

	return [query, get, set, write];
}

/** The operation's tool, rendered from its description. */
const operationTool = (operation: Operation): Tool => ({
	name: operation.name,
	title: `epicenter ${operation.name}`,
	description: [operation.summary, operation.details]
		.filter(Boolean)
		.join('\n\n'),
	inputSchema: plain(operation.input),
	outputSchema: plain(operation.output),
});

/** The folder a writing operation's input names, so its writes are synced. */
const WRITES: Record<string, (input: Record<string, unknown>) => unknown> = {
	init: (input) => input.path,
	format: (input) => input.dir,
};

const answerOf = (answer: ToolAnswer): CallToolResult =>
	answer.error !== null
		? { content: [{ type: 'text', text: answer.error }], isError: true }
		: {
				content: [{ type: 'text', text: JSON.stringify(answer.data) }],
				structuredContent: answer.data,
			};

/**
 * The MCP server over `root`, reaching `reach`, keeping what it writes in
 * sync through `kept` when it has one. `close` ends it, syncing once more.
 */
export function createMcpServer({
	root,
	reach,
	sync,
}: {
	root: EpicenterRoot;
	reach: Reach;
	/** How the folders it writes are kept in sync; absent signed out. */
	sync?: (written: () => ReadonlySet<string>) => KeptFolders;
}) {
	const opened = new Map<string, Opened>();
	/** The folders it wrote, by name, kept in sync from then. */
	const written = new Set<string>();
	const kept = sync?.(() => written);
	const wrote = (path: string) => {
		const name = path.slice(root.path.length + 1);
		if (name === '' || name.includes('/')) return;
		written.add(name);
		kept?.changed(path);
	};
	const derive = derivedTools({ root, reach, opened, wrote });
	/** The derived tools as last listed: listing reads every folder, so a call reads them only for a name it does not know. */
	let listed: Map<string, DerivedTool> | null = null;
	const derived = async () => {
		listed = await derive();
		return listed;
	};

	const server = new Server(
		{ name: 'epicenter', version: packageJson.version },
		{
			capabilities: { tools: {} },
			instructions:
				"Epicenter's folders: every operation of the epicenter command, and tools over each folder's collections (<folder>_<collection>_query, _get, _set, _write). Writes go through the folder as an app's do, and are synced.",
		},
	);

	server.setRequestHandler(ListToolsRequestSchema, async () => ({
		tools: [
			...OPERATIONS.map(operationTool),
			...[...(await derived()).values()].map(({ tool }) => tool),
		],
	}));

	server.setRequestHandler(CallToolRequestSchema, async (request) => {
		const { name, arguments: args = {} } = request.params;
		const operation = OPERATIONS.find((one) => one.name === name);
		if (operation !== undefined) {
			if (!Value.Check(operation.input, args)) {
				const [first] = Value.Errors(operation.input, args);
				throw new McpError(
					ErrorCode.InvalidParams,
					`${name}: ${first?.instancePath || 'input'} ${first?.message ?? 'is not what it takes'}`,
				);
			}
			const implementation = await operation.load();
			const answer = await implementation.run(args as never);
			if (answer.error === null) {
				const target = WRITES[name]?.(args);
				const named = await folderNameIn(
					root,
					typeof target === 'string' ? target : '.',
				);
				if (WRITES[name] !== undefined && named.error === null)
					wrote(`${root.path}/${named.data}`);
			}
			return answerOf(
				answer.error !== null
					? answer
					: Ok(answer.data.output as Record<string, unknown>),
			);
		}
		const tool = listed?.get(name) ?? (await derived()).get(name);

		if (tool === undefined)
			throw new McpError(ErrorCode.InvalidParams, `No tool ${name}`);
		return answerOf(await tool.run(args));
	});

	return {
		server,
		connect: (transport: Transport) => server.connect(transport),
		/** The folders it wrote, by name. */
		written: () => written as ReadonlySet<string>,
		/** End it: a last sync of what it wrote, then every folder it opened closed. */
		async close() {
			await server.close();
			if (kept !== undefined && written.size > 0) await kept.now();
			kept?.[Symbol.dispose]();
			for (const { folder } of opened.values()) folder[Symbol.dispose]();
			opened.clear();
		},
	};
}

/** `epicenter mcp [<dir> ...] [--all]`: serve until the agent closes stdin. */
export async function mcpCommand({
	dirs,
	all,
}: {
	dirs: readonly string[];
	all: boolean;
}): Promise<number> {
	const root = homeRoot();
	if (all === dirs.length > 0) {
		writeErr('Name the folders to serve, or give --all for every folder.');
		return EXIT.unusable;
	}
	const names = new Set<string>();
	for (const dir of dirs) {
		const named = await folderNameIn(root, dir);
		if (named.error !== null) {
			writeErr(named.error);
			return EXIT.unusable;
		}
		names.add(named.data);
	}
	const signedIn = await signedInNow(authContext());
	if (signedIn.error !== null)
		writeErr(
			`epicenter mcp writes your folders, and does not sync them: ${signedIn.error}`,
		);
	const served = createMcpServer({
		root,
		reach: all ? { all: true } : { names },
		sync:
			signedIn.error !== null
				? undefined
				: (written) =>
						keepEverySynced({
							account: signedIn.data,
							root,
							apps: firstPartyApps(),
							only: written,
						}),
	});
	const transport = new StdioServerTransport();
	const closed = new Promise<void>((resolve) => {
		served.server.onclose = resolve;
		process.stdin.once('end', resolve);
	});
	await served.connect(transport);
	await closed;
	await served.close();
	return EXIT.ok;
}
