import * as path from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pathToFileURL } from 'node:url';
import * as machineAuth from '@epicenter/auth/node';
import { createEpicenterClient } from '@epicenter/client';
import {
	createHttpReplicaSyncPort,
	type TablesApplyPlan,
	type WorkspaceDefinition,
} from '@epicenter/workspace/sqlite';
import { applyPortableTables } from '@epicenter/workspace/sqlite/bun';
import { extractErrorMessage } from 'wellcrafted/error';
import { cmd } from '../util/cmd.js';
import { fail, formatOptions, output } from '../util/format-output.js';

const applyCommand = cmd({
	command: 'apply <tables>',
	describe: 'Review and apply an edited tables.sqlite3 as forward mutations',
	builder: (yargs) =>
		yargs
			.positional('tables', {
				type: 'string',
				demandOption: true,
				describe: 'Edited tables.sqlite3 with sibling workspace.json',
			})
			.option('definition', {
				type: 'string',
				demandOption: true,
				describe: 'Module exporting the locked workspaceDefinition',
			})
			.option('yes', {
				alias: 'y',
				type: 'boolean',
				default: false,
				describe: 'Approve every latest-head preview without prompting',
			})
			.options(formatOptions)
			.strict(),
	handler: async (argv) => {
		try {
			const definition = await loadDefinition(argv.definition);
			const { data: auth, error } =
				await machineAuth.resolveMachineAuthClient();
			if (error) {
				fail(error.message);
				return;
			}
			if (auth.state.status === 'signed-out') {
				fail('not signed in: run `epicenter auth login` first');
				return;
			}
			const epicenter = createEpicenterClient({
				baseURL: auth.deployment.baseURL,
				fetch: (input, init) => auth.fetch(input, init),
			});
			const reviews: ReturnType<typeof preview>[] = [];
			const result = await applyPortableTables(definition, {
				tablesPath: path.resolve(argv.tables),
				authority: createHttpReplicaSyncPort({
					baseUrl: auth.deployment.baseURL,
					fetch: (input, init) => auth.fetch(input, init),
				}),
				isBlobAvailable: async (ref) => {
					const { data: stored, error: headError } = await epicenter.blobs.head(
						ref.hash,
					);
					if (headError) return false;
					return stored.size === ref.size && stored.mediaType === ref.mediaType;
				},
				confirm: async (plan, head) => {
					const review = preview(plan, head);
					reviews.push(review);
					if (argv.yes) return true;
					console.error(JSON.stringify(review, null, 2));
					if (!process.stdin.isTTY || !process.stderr.isTTY) {
						throw new Error('Tables apply requires a TTY or explicit --yes');
					}
					const terminal = createInterface({
						input: process.stdin,
						output: process.stderr,
					});
					try {
						const answer = await terminal.question(
							`Apply ${plan.mutations.length} mutations at head ${head}? [y/N] `,
						);
						return answer.trim().toLowerCase() === 'y';
					} finally {
						terminal.close();
					}
				},
			});
			output(argv.yes ? { reviews, result } : result, { format: argv.format });
		} catch (cause) {
			fail(extractErrorMessage(cause), { code: 2 });
		}
	},
});

export const tablesCommand = cmd({
	command: 'tables <subcommand>',
	describe: 'Inspect and apply portable workspace tables',
	builder: (yargs) =>
		yargs.command(applyCommand).demandCommand(1, 'Specify a subcommand: apply'),
	handler: () => {},
});

async function loadDefinition(
	modulePath: string,
): Promise<WorkspaceDefinition> {
	const imported = (await import(
		pathToFileURL(path.resolve(modulePath)).href
	)) as Record<string, unknown>;
	const definition = imported.workspaceDefinition;
	if (
		typeof definition !== 'object' ||
		definition === null ||
		typeof (definition as { appId?: unknown }).appId !== 'string' ||
		typeof (definition as { version?: unknown }).version !== 'number' ||
		typeof (definition as { workspaceId?: unknown }).workspaceId !== 'string'
	) {
		throw new Error(
			`Definition module '${modulePath}' must export workspaceDefinition`,
		);
	}
	return definition as WorkspaceDefinition;
}

function preview(plan: TablesApplyPlan, head: number) {
	return {
		head,
		creates: plan.creates,
		updates: plan.updates,
		deletes: plan.deletes,
		documentFallout: plan.documentFallout,
		blobFallout: plan.blobFallout,
		mutationCount: plan.mutations.length,
	};
}
