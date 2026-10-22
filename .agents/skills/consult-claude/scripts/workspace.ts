import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

/** Only the coordinating host may reopen an assigned skill subtree. */
export function resolveSkillWriteRoots(cwd: string, roots: string[]) {
	return [
		...new Set(
			roots.map((root) => {
				const path = realpathSync(resolve(cwd, root));
				const subpath = relative(cwd, path);
				if (
					!subpath.startsWith('.agents/skills/') ||
					subpath.split('/').length < 3 ||
					!statSync(path).isDirectory()
				)
					throw new Error(
						'Skill write roots must resolve inside the assigned checkout .agents/skills directory.',
					);
				return subpath;
			}),
		),
	];
}

/** Delivery targets the current checkout or an external standalone clone. */
export function assertDelegateWorkspace(source: string, cwd: string) {
	for (const path of cwd === source
		? []
		: [relative(source, cwd), relative(cwd, source)]) {
		if (
			path === '' ||
			(path !== '..' && !path.startsWith('../') && !isAbsolute(path))
		)
			throw new Error(
				'Delegate workspace must be outside the coordinating checkout.',
			);
	}
	const target = spawnSync(
		'git',
		['rev-parse', '--show-toplevel', '--git-common-dir'],
		{
			cwd,
			encoding: 'utf8',
		},
	);
	if (target.error) throw target.error;
	if (target.status !== 0)
		throw new Error('Delegate workspace must be a Git clone.');
	const [root, common] = target.stdout.trim().split('\n');
	if (
		!root ||
		!common ||
		realpathSync(root) !== cwd ||
		(cwd !== source &&
			realpathSync(resolve(cwd, common)) !== resolve(cwd, '.git'))
	)
		throw new Error(
			'Delegate workspace must be the current checkout root or an external standalone clone.',
		);
	if (cwd === source) return;
	const origin = spawnSync('git', ['remote', 'get-url', 'origin'], {
		cwd,
		encoding: 'utf8',
	});
	let originRoot: string | undefined;
	try {
		const originUrl = origin.stdout.trim();
		if (isAbsolute(originUrl)) originRoot = realpathSync(originUrl);
	} catch {
		// A missing or non-local origin cannot establish source provenance.
	}
	if (origin.status !== 0 || originRoot !== source)
		throw new Error(
			'Delegate workspace must be cloned from the coordinating checkout using its absolute local path.',
		);
}
