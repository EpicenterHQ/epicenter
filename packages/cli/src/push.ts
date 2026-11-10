/** Push the home branch to its optional backup without changing the working tree. */
import { git, gitMessage } from './git.ts';

export async function pushOrigin(
	folder: string,
): Promise<
	| { pushed: false; noOrigin: true }
	| { pushed: true }
	| { pushed: false; error: { message: string; next?: string } }
> {
	if ((await git(folder, ['remote', 'get-url', 'origin'])).code !== 0)
		return { pushed: false, noOrigin: true };
	const branch = (await git(folder, ['symbolic-ref', '-q', '--short', 'HEAD']))
		.stdout;
	if (!branch)
		return {
			pushed: false,
			error: { message: 'is not on a branch, so nothing was pushed' },
		};
	const args = ['push', 'origin', `HEAD:${branch}`];
	const result = await git(folder, args);
	if (result.code === 0) return { pushed: true };
	if (
		/non-fast-forward|\[rejected\].*fetch first|\[rejected\].*non-fast-forward/i.test(
			result.stderr,
		)
	)
		return {
			pushed: false,
			error: {
				message:
					'The backup at origin has changes this computer does not; nothing was overwritten',
				next: `git -C ${folder} fetch origin && git -C ${folder} log HEAD..origin/${branch}`,
			},
		};
	return {
		pushed: false,
		error: {
			message: `not pushed: ${gitMessage(args, result)}`,
			next: `git -C ${folder} push origin HEAD:${branch}`,
		},
	};
}
