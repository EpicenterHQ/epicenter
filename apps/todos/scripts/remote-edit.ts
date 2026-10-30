/**
 * Demo fixture: another computer edits a todo by hand and pushes it with
 * ordinary Git.
 *
 *   bun apps/todos/scripts/remote-edit.ts <native-checkout> <stem> [title]
 *
 * Run it against the native checkout `bun dev:todos` prints. It pulls the
 * checkout with `git pull --ff-only`, rewrites `todos/<stem>.md` the way a
 * person editing the file might (a YAML comment, a new title, done set, and
 * the keys `owner` and `labels`, which Todos does not declare), then commits
 * and pushes. In the browser, Fetch and Pull show the changed todo; its file
 * shows the comment and keys in the source, and saving the todo later keeps
 * the keys while writing canonical frontmatter without the comment. Prints
 * what it pushed as JSON.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const [checkout, stem, title = 'Edited on another computer'] =
	process.argv.slice(2);
if (checkout === undefined || stem === undefined) {
	console.error(
		'Usage: bun apps/todos/scripts/remote-edit.ts <native-checkout> <stem> [title]',
	);
	process.exit(2);
}

async function git(...args: string[]) {
	const child = Bun.spawn(['git', '-C', checkout!, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	if (code !== 0) {
		console.error(`git ${args.join(' ')} failed: ${stderr.trim()}`);
		process.exit(1);
	}
	return stdout.trim();
}

const path = `todos/${stem}.md`;
const source = `---
# Edited by hand on another computer
title: ${JSON.stringify(title)}
done: true
owner: sam
labels: [home, weekly]
---
Changed outside Todos, then pushed with ordinary Git.
`;

await git('pull', '--quiet', '--ff-only');
await writeFile(join(checkout, path), source);
await git('add', '--', path);
await git('commit', '--quiet', '-m', `Edit ${path} by hand`);
await git('push', '--quiet', 'origin', 'main');
console.log(
	JSON.stringify(
		{ pushed: await git('rev-parse', 'HEAD'), path, source },
		null,
		2,
	),
);
