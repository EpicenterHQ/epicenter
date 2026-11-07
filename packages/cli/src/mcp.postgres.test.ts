/**
 * `epicenter mcp` (ADR-0799, ADR-0819, ADR-0827), as an agent reaches it:
 * through the official SDK's client, over stdio to a fresh CLI process,
 * and in process over a linked transport against the real server on a
 * disposable Postgres cluster. Requires initdb and pg_ctl on PATH.
 *
 * Key behaviors:
 * - The CLI and MCP list the same operations, each tool with the input
 *   schema its command takes
 * - A folder's contract becomes query, get, set, and write tools, and a
 *   call round-trips against a real folder: written in house style, read
 *   back, queried, and refused before writing a field that does not fit
 * - An operation's tool answers its output as structured content
 * - The folders it writes are synced after a burst of writes and as it ends
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { epicenterRoot } from '@epicenter/folder/node';
import { keepEverySynced, syncFolder } from '@epicenter/folder/platform';
import { folderRepository } from '@epicenter/folder/sync';
import { expectOk } from 'wellcrafted/testing';
import { startRepositoryServer } from '../../server/src/test-helpers/repository-server.ts';
import { CLI_COMMANDS } from './commands.ts';
import { createMcpServer } from './mcp.ts';
import { OPERATIONS } from './operations.ts';

const bin = resolve(import.meta.dir, 'bin.ts');
let server: Awaited<ReturnType<typeof startRepositoryServer>>;
let scratch: string;

beforeAll(async () => {
	scratch = await mkdtemp(join(tmpdir(), 'epicenter-mcp-'));
	server = await startRepositoryServer();
}, 120_000);

afterAll(async () => {
	await server?.stop();
	if (scratch) await rm(scratch, { recursive: true, force: true });
});

const contract = {
	title: 'Recipes',
	collections: {
		recipes: {
			path: 'recipes/{name}.md',
			fields: { title: { type: 'string' }, minutes: { type: 'number' } },
			required: ['title'],
		},
		photos: { path: 'photos/{name}.{ext}' },
	},
};

/** An Epicenter folder at `home/Epicenter` holding the folder `Recipes`. */
async function recipesAt(home: string) {
	const folder = join(home, 'Epicenter', 'Recipes');
	await mkdir(join(folder, 'recipes'), { recursive: true });
	await writeFile(join(folder, 'epicenter.json'), JSON.stringify(contract));
	await writeFile(
		join(folder, 'recipes/soup.md'),
		'---\ntitle: Soup\nminutes: 30\n---\nBoil.\n',
	);
	return folder;
}

/** What a tool call answered, as structured content. */
const structured = (result: unknown) =>
	(result as { structuredContent?: Record<string, unknown> }).structuredContent;

test('the CLI and MCP list the same operations, and a tool call round-trips against a real folder', async () => {
	const home = join(scratch, 'stdio');
	const folder = await recipesAt(home);
	const transport = new StdioClientTransport({
		command: process.execPath,
		args: ['--no-install', bin, 'mcp', '--all'],
		cwd: home,
		stderr: 'pipe',
		env: {
			PATH: process.env.PATH ?? '',
			HOME: home,
			EPICENTER_DATA_DIR: join(home, 'data'),
			EPICENTER_TEST_SECRETS: '{}',
			// Signed out: it writes, and says on stderr that it does not sync.
			EPICENTER_API_URL: 'http://127.0.0.1:9',
		},
	});
	const client = new Client({ name: 'test-agent', version: '1.0.0' });
	await client.connect(transport);
	try {
		const { tools } = await client.listTools();
		const names = tools.map(({ name }) => name);

		// The same operations: every command but the CLI's own is a tool.
		const help = Bun.spawnSync(
			[process.execPath, '--no-install', bin, '--help', '--json'],
			{ stdout: 'pipe' },
		);
		const commands = (
			JSON.parse(help.stdout.toString()) as {
				commands: { command: string; input?: object }[];
			}
		).commands;
		const own = new Set(CLI_COMMANDS.map(({ path }) => path.join(' ')));
		const operations = commands
			.map(({ command }) => command)
			.filter((command) => !own.has(command));
		expect(operations).toEqual(OPERATIONS.map(({ name }) => name));
		expect(names.filter((name) => !name.includes('_'))).toEqual(operations);
		for (const { command, input } of commands.filter(
			({ command }) => !own.has(command),
		))
			expect(tools.find(({ name }) => name === command)?.inputSchema).toEqual(
				input as never,
			);

		// The contract's collections, as tools.
		expect(names.filter((name) => name.includes('_')).sort()).toEqual([
			'recipes_photos_query',
			'recipes_recipes_get',
			'recipes_recipes_query',
			'recipes_recipes_set',
			'recipes_recipes_write',
		]);
		const set = tools.find(({ name }) => name === 'recipes_recipes_set');
		expect(set?.inputSchema).toMatchObject({
			properties: {
				name: { type: 'string' },
				fields: { properties: { minutes: { type: 'number' } } },
			},
			required: ['name', 'fields'],
		});

		// A write lands in house style, through the folder.
		const written = await client.callTool({
			name: 'recipes_recipes_write',
			arguments: {
				name: 'bread',
				body: 'Knead.\n',
				fields: { minutes: 90, title: 'Bread' },
			},
		});
		expect(written.isError).toBeFalsy();
		expect(structured(written)).toEqual({
			item: { name: 'bread', title: 'Bread', minutes: 90, body: 'Knead.\n' },
		});
		expect(await readFile(join(folder, 'recipes/bread.md'), 'utf8')).toBe(
			'---\ntitle: Bread\nminutes: 90\n---\nKnead.\n',
		);

		// Fields set, the body kept; read back and queried.
		await client.callTool({
			name: 'recipes_recipes_set',
			arguments: { name: 'soup', fields: { minutes: 45 } },
		});
		expect(
			structured(
				await client.callTool({
					name: 'recipes_recipes_get',
					arguments: { name: 'soup' },
				}),
			),
		).toEqual({
			item: { name: 'soup', title: 'Soup', minutes: 45, body: 'Boil.\n' },
		});
		expect(
			structured(
				await client.callTool({
					name: 'recipes_recipes_query',
					arguments: { where: { minutes: 90 } },
				}),
			),
		).toEqual({
			items: [{ name: 'bread', title: 'Bread', minutes: 90 }],
			invalid: [],
		});

		// A field that does not fit the contract is refused before anything is written.
		const refused = await client.callTool({
			name: 'recipes_recipes_set',
			arguments: { name: 'soup', fields: { minutes: 'long' } },
		});
		expect(refused.isError).toBe(true);
		expect(JSON.stringify(refused.content)).toContain('minutes');
		expect(await readFile(join(folder, 'recipes/soup.md'), 'utf8')).toBe(
			'---\ntitle: Soup\nminutes: 45\n---\nBoil.\n',
		);

		// An operation answers its output as structured content.
		const checked = await client.callTool({
			name: 'check',
			arguments: { dir: folder },
		});
		expect(structured(checked)).toEqual({ files: 2, issues: [], exitCode: 0 });
		const usage = await client
			.callTool({ name: 'log', arguments: { limit: 'many' } })
			.catch((error: Error) => error);
		expect(String(usage)).toContain('limit');
	} finally {
		await client.close();
	}
}, 60_000);

test('the folders it writes are synced after a burst of writes, and as it ends', async () => {
	const account = await server.signIn('mcp-sync');
	const home = join(scratch, 'synced');
	await recipesAt(home);
	const root = epicenterRoot(join(home, 'Epicenter'));
	const first = expectOk(await syncFolder({ account, root, name: 'Recipes' }));
	if (first.kind !== 'synced') throw new Error('expected a sync');
	const remote = folderRepository(account, first.folder);
	const onServer = async (path: string) => {
		const at = expectOk(await remote.filesAt({ paths: [path] }));
		return at.files[0]?.version ?? null;
	};

	const served = createMcpServer({
		root,
		reach: { all: true },
		sync: (written) =>
			keepEverySynced({
				account,
				root,
				only: written,
				afterChangeMs: 1000,
				checkEveryMs: 60_000,
			}),
	});
	const [ours, theirs] = InMemoryTransport.createLinkedPair();
	const client = new Client({ name: 'test-agent', version: '1.0.0' });
	await Promise.all([served.connect(theirs), client.connect(ours)]);

	await client.callTool({
		name: 'recipes_recipes_write',
		arguments: { name: 'stew', body: 'Simmer.\n', fields: { title: 'Stew' } },
	});
	expect([...served.written()]).toEqual(['Recipes']);
	// After the burst, a round syncs it.
	for (
		let tries = 0;
		tries < 100 && (await onServer('recipes/stew.md')) === null;
		tries++
	)
		await Bun.sleep(50);
	expect(await onServer('recipes/stew.md')).not.toBeNull();

	// Written just before it ends, the last round takes it.
	await client.callTool({
		name: 'recipes_recipes_set',
		arguments: { name: 'stew', fields: { minutes: 120 } },
	});
	const before = await onServer('recipes/stew.md');
	await client.close();
	await served.close();
	expect(await onServer('recipes/stew.md')).not.toBe(before);
}, 60_000);
