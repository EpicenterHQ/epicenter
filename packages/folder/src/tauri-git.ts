/**
 * The native Git backend's `git`, run by the desktop shell for a folder it
 * granted this window (`run_git`). The shell decides which operations are
 * allowed and how Git runs; this module only carries a call there and back.
 */
import { GitCommandError, type GitRun } from './git/native-backend.js';
import { commands } from './native/bindings.gen.js';

/**
 * A run's name for `cancel_git`, counted within this page. The shell keys
 * runs by window, the page loaded in it, and this number, so no two runs
 * share a name, and a reloaded page starts again from zero.
 */
let nextRequest = 0;

const encoder = new TextEncoder();

/** `git` for the granted folder `scope`. */
export function tauriGitRun(scope: string): GitRun {
	return async (args, options = {}) => {
		const { signal } = options;
		signal?.throwIfAborted();
		const env = options.env ?? {};
		for (const name of Object.keys(env))
			if (name !== 'GIT_INDEX_FILE')
				throw new Error(`git cannot be given ${name} from a page`);
		const input =
			options.input === undefined
				? null
				: Array.from(
						typeof options.input === 'string'
							? encoder.encode(options.input)
							: options.input,
					);
		const request = nextRequest++;
		const cancel = () => {
			void commands.cancelGit(request);
		};
		signal?.addEventListener('abort', cancel, { once: true });
		let reply: Awaited<ReturnType<typeof commands.runGit>>;
		try {
			reply = await commands.runGit(
				scope,
				[...args],
				input,
				env.GIT_INDEX_FILE ?? null,
				request,
			);
		} finally {
			signal?.removeEventListener('abort', cancel);
		}
		const { data, error } = reply;
		if (error !== null)
			throw new Error(
				typeof error === 'object' && error !== null && 'message' in error
					? String((error as { message: unknown }).message)
					: `git could not run: ${JSON.stringify(error)}`,
			);
		signal?.throwIfAborted();
		const result = {
			code: data.code,
			stdout: Uint8Array.from(data.stdout),
			stderr: data.stderr,
		};
		if (result.code !== 0 && !options.allowFailure)
			throw new GitCommandError(args, result.code, result.stderr);
		return result;
	};
}
