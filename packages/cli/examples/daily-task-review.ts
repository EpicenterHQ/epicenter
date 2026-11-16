/**
 * A daily review is a draft, not a task mutation. Read the Tasks app through
 * its list action and publish a dated draft only when that file is absent.
 * Running it again preserves the person's edits. No model or credentials are
 * needed. The home repository backs up drafts alongside the routine itself.
 */
import { randomUUID } from 'node:crypto';
import { link, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

function dayOf(date: Date) {
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const root = process.cwd();
const day = dayOf(new Date());
const directory = join(root, 'drafts');
const target = join(directory, `task-review-${day}.md`);
try {
	await readFile(target);
	console.log(`Draft already exists: drafts/task-review-${day}.md`);
} catch (error) {
	if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
	const command: unknown = process.env.EPICENTER_COMMAND
		? JSON.parse(process.env.EPICENTER_COMMAND)
		: ['epicenter'];
	if (
		!Array.isArray(command) ||
		!command.length ||
		!command.every((word) => typeof word === 'string')
	)
		throw new Error(
			'EPICENTER_COMMAND must be an array of executable and arguments',
		);
	const child = Bun.spawn([...command, 'tasks', 'list', '--json'], {
		cwd: root,
		env: { ...process.env, BUN_BE_BUN: undefined },
		stdin: 'ignore',
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) throw new Error(`Could not read tasks: ${stderr || stdout}`);
	const answer = JSON.parse(stdout);
	if (answer.result?.error !== null || !Array.isArray(answer.result.data))
		throw new Error('tasks list did not return a task list');
	const groups = {
		Overdue: [] as string[],
		'Due today': [] as string[],
		Upcoming: [] as string[],
		'No due date': [] as string[],
	};
	for (const row of answer.result.data) {
		if (row.error !== null)
			throw new Error(
				`Task needs attention before review: ${String(row.error?.path)}`,
			);
		const task = row.data;
		if (typeof task.path !== 'string' || typeof task.title !== 'string')
			throw new Error(
				`Task needs attention before review: ${String(task.path)}`,
			);
		if (task.done === true) continue;
		const due = task.due;
		if (
			due !== undefined &&
			(typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due))
		)
			throw new Error(`Task has an invalid due date: ${task.path}`);
		const group =
			due === undefined
				? 'No due date'
				: due < day
					? 'Overdue'
					: due === day
						? 'Due today'
						: 'Upcoming';
		const title = task.title
			.replace(/[\\`*_{}[\]<>]/g, '\\$&')
			.replace(/[\r\n]+/g, ' ');
		const href = `../apps/tasks/${task.path.split('/').map(encodeURIComponent).join('/')}`;
		groups[group].push(
			`- [ ] [${title}](${href})${due ? ` (due ${due})` : ''}`,
		);
	}
	const count = Object.values(groups).reduce(
		(total, tasks) => total + tasks.length,
		0,
	);
	const body = `---\nstatus: "draft"\nday: "${day}"\n---\n# Task review: ${day}\n\nDraft for your review. Task completion and dates have not been changed.\n\n${count} open task${count === 1 ? '' : 's'}.\n\n${Object.entries(
		groups,
	)
		.map(
			([title, tasks]) =>
				`## ${title}\n\n${tasks.length ? tasks.sort().join('\n') : 'None.'}\n`,
		)
		.join('\n')}`;
	await mkdir(directory, { recursive: true });
	const temporary = join(directory, `${randomUUID()}.local.md`);
	try {
		await writeFile(temporary, body, { mode: 0o600, flag: 'wx' });
		// Publishing via link is atomic and refuses to replace an edited draft.
		try {
			await link(temporary, target);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
		}
	} finally {
		await rm(temporary, { force: true });
	}
	console.log(`Draft ready: drafts/task-review-${day}.md`);
}
