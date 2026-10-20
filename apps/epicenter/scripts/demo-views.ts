#!/usr/bin/env bun
/** Build the real desktop app and open disposable folders for a saved-view walkthrough. */
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Declaration } from '@epicenter/folder/declaration';

if (process.platform !== 'darwin')
	throw new Error('This demo launcher currently opens the macOS app bundle.');

const repo = resolve(import.meta.dir, '../../..');
const app = join(repo, 'apps/epicenter');
const bundle = join(
	app,
	'src-tauri/target/debug/bundle/macos/Epicenter Views Demo.app',
);
const executable = join(bundle, 'Contents/MacOS/epicenter');
const active = Bun.spawnSync(
	['pgrep', '-f', `^${executable.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`],
	{ stdout: 'ignore', stderr: 'ignore' },
);
if (active.exitCode === 0)
	throw new Error(
		'Epicenter Views Demo is already running. Quit that demo before starting a fresh walkthrough.',
	);
const root = await mkdtemp(join(tmpdir(), 'epicenter-views-demo-'));
const folderDir = join(root, 'Folders');
const dataDir = join(root, 'AppData');
const project = join(folderDir, 'Project');
const plain = join(folderDir, 'Plain notes');
await Promise.all([
	mkdir(join(project, 'tasks'), { recursive: true }),
	mkdir(join(plain, 'notes'), { recursive: true }),
	mkdir(dataDir, { recursive: true }),
]);
await writeFile(
	join(project, 'epicenter.json'),
	`${JSON.stringify(
		{
			title: 'Project',
			tables: {
				tasks: {
					type: 'object',
					properties: {
						title: { type: 'string' },
						status: { enum: ['Todo', 'Doing', 'Done'] },
						priority: { type: 'integer' },
						done: { type: 'boolean' },
					},
				},
			},
			views: {
				board: {
					type: 'board',
					title: 'Project board',
					table: 'tasks',
					groupBy: 'status',
					columns: ['title', 'priority', 'done'],
					sort: [{ field: 'priority', direction: 'asc' }],
				},
				grid: {
					type: 'grid',
					title: 'All tasks',
					table: 'tasks',
					columns: ['title', 'status', 'priority', 'done'],
					sort: [{ field: 'priority', direction: 'asc' }],
				},
				progress: {
					type: 'sql',
					title: 'Progress by status',
					sql: "SELECT json_extract(fields, '$.status') AS status, COUNT(*) AS tasks FROM documents WHERE directory = 'tasks' GROUP BY status ORDER BY status",
				},
			},
		} satisfies Declaration,
		null,
		2,
	)}\n`,
);
for (const [id, title, status, priority, done] of [
	['board', 'Try moving this card', 'Todo', 1, false],
	['source', 'Open a task as source', 'Doing', 2, false],
	['grid', 'Edit a title in the grid', 'Todo', 3, false],
	['sql', 'Run the progress query', 'Done', 4, true],
] as const) {
	await writeFile(
		join(project, 'tasks', `${id}.md`),
		`---\ntitle: ${title}\nstatus: ${status}\npriority: ${priority}\ndone: ${done}\n---\nThis is a real Markdown file. Grid, board, and Files edit this same source.\n`,
	);
}
await writeFile(
	join(plain, 'notes', 'first.md'),
	'---\ntitle: No schema required\ncategory: Ideas\n---\nChoose Tables, select notes, then save your first view.\n',
);
const config = join(root, 'tauri.demo.json');
await writeFile(
	config,
	JSON.stringify({
		productName: 'Epicenter Views Demo',
		identifier: 'so.epicenter.views-demo',
		plugins: {
			'deep-link': { desktop: { schemes: ['epicenter-views-demo'] } },
		},
	}),
);

await writeFile(
	join(root, 'demo.json'),
	JSON.stringify({ root, folderDir, dataDir, project, plain, bundle }, null, 2),
);
console.log(`\nDemo files: ${root}\n`);
console.log(
	'Building the actual desktop application. No API server or sign-in is needed for this local walkthrough.',
);
const built = Bun.spawn(
	['bun', 'run', '--cwd', app, 'tauri', 'build', '--debug', '--config', config],
	{
		cwd: repo,
		stdout: 'inherit',
		stderr: 'inherit',
		stdin: 'inherit',
	},
);
if ((await built.exited) !== 0)
	throw new Error(`The demo build failed. Its sample data is still at ${root}`);
console.log(
	`\nOpening Epicenter Views Demo.\n1. Open Project, then choose Project board under Saved views.\n2. Move a card; switch to All tasks or Files to inspect the same edit.\n3. Choose Progress by status and Run SQL.\n4. Rename a view and Save view. Close/reopen Project to check persistence.\n5. Open Plain notes to try Tables without epicenter.json.\n\nData remains at ${root}. Ctrl-C stops only this demo app.\n`,
);
const running = Bun.spawn([executable], {
	cwd: repo,
	stdout: 'inherit',
	stderr: 'inherit',
	stdin: 'inherit',
	env: {
		...process.env,
		EPICENTER_DATA_DIR: dataDir,
		EPICENTER_FOLDER_DIR: folderDir,
	},
});
for (const signal of ['SIGINT', 'SIGTERM'] as const)
	process.on(signal, () => running.kill(signal));
process.exit(await running.exited);
