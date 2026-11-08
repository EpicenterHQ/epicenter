/** Pull and push each app repository without committing local edits (ADR-0842). */
import { realpath } from 'node:fs/promises';
import { checkedGit, dirtyPaths, git } from './git.ts';
import { discoverAll } from './home.ts';
import { writeJson, writeOut } from './output.ts';

type SyncApp = {
	name: string;
	folder: string;
	status: 'current' | 'pulled' | 'pushed' | 'no-remote' | 'conflict' | 'failed';
	pulled?: number;
	pushed?: number;
	conflicts?: string[];
	uncommitted?: string[];
	message?: string;
};

function count(bytes: Buffer) {
	return Number(bytes.toString().trim());
}

export async function syncCommand(json: boolean): Promise<number> {
	const found = await discoverAll();
	const apps: SyncApp[] = found.problems.map((app) => ({
		name: app.name,
		folder: app.realPath,
		status: 'failed',
		message: app.problems.join('; '),
	}));
	const seen = new Set<string>();
	for (const app of found.apps) {
		if (seen.has(app.realPath)) continue;
		seen.add(app.realPath);
		const row: SyncApp = {
			name: app.name,
			folder: app.realPath,
			status: 'current',
		};
		apps.push(row);
		try {
			const top = await git(app.realPath, 'rev-parse', '--show-toplevel');
			if (
				top.code !== 0 ||
				(await realpath(top.stdout.toString().trim())) !== app.realPath
			) {
				row.status = 'failed';
				row.message = `${app.realPath} must be the top level of a Git repository`;
				continue;
			}
			const local = await dirtyPaths(app.realPath);
			if (local.length) row.uncommitted = local;
			const upstream = await git(
				app.realPath,
				'rev-parse',
				'--abbrev-ref',
				'--symbolic-full-name',
				'@{upstream}',
			);
			if (upstream.code !== 0) {
				row.status = 'no-remote';
				continue;
			}
			const oldHead = (await checkedGit(app.realPath, 'rev-parse', 'HEAD'))
				.toString()
				.trim();
			const pull = await git(app.realPath, 'pull', '--no-rebase', '--no-edit');
			if (pull.code !== 0) {
				const conflicts = (
					await checkedGit(
						app.realPath,
						'diff',
						'--name-only',
						'--diff-filter=U',
						'-z',
					)
				)
					.toString()
					.split('\0')
					.filter(Boolean);
				row.status = conflicts.length ? 'conflict' : 'failed';
				if (conflicts.length) row.conflicts = conflicts;
				const after = await dirtyPaths(app.realPath);
				if (after.length) row.uncommitted = after;
				row.message = pull.stderr || pull.stdout.toString().trim();
				continue;
			}
			const pulled = count(
				await checkedGit(
					app.realPath,
					'rev-list',
					'--count',
					`${oldHead}..@{upstream}`,
				),
			);
			if (pulled) row.pulled = pulled;
			const pushed = count(
				await checkedGit(
					app.realPath,
					'rev-list',
					'--count',
					'@{upstream}..HEAD',
				),
			);
			const push = await git(app.realPath, 'push');
			if (push.code !== 0) {
				row.status = 'failed';
				row.message = push.stderr || push.stdout.toString().trim();
				continue;
			}
			if (pushed) row.pushed = pushed;
			row.status = pushed ? 'pushed' : pulled ? 'pulled' : 'current';
			const after = await dirtyPaths(app.realPath);
			if (after.length) row.uncommitted = after;
			else delete row.uncommitted;
		} catch (error) {
			row.status = 'failed';
			row.message = error instanceof Error ? error.message : String(error);
		}
	}
	if (json) writeJson({ apps });
	else
		for (const row of apps) {
			const label =
				row.status === 'current'
					? 'up to date'
					: row.status === 'no-remote'
						? 'no remote'
						: row.status === 'pulled'
							? `pulled ${row.pulled} commits`
							: row.status === 'pushed'
								? `pushed ${row.pushed} commits`
								: row.status;
			writeOut(`${row.name}: ${label}`);
			if (row.conflicts?.length)
				writeOut(`  conflicted: ${row.conflicts.join(', ')}`);
			if (row.uncommitted?.length)
				writeOut(`  uncommitted: ${row.uncommitted.join(', ')}`);
			if (row.message) writeOut(`  ${row.message}`);
		}
	return apps.some(
		(app) =>
			app.status === 'conflict' ||
			app.status === 'failed' ||
			app.uncommitted?.length,
	)
		? 1
		: 0;
}
