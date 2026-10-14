/**
 * The native Git backend's `git`, run by the desktop shell for a folder it
 * granted this window (`run_git`). The shell decides which operations are
 * allowed and how Git runs; this module only carries a call there and back.
 */
import { GitCommandError, type GitRun } from './git/native-backend.js';
import { commands } from './native/bindings.gen.js';

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
		// The run's name for `cancel_git`. The shell keys runs by window and
		// this ID, so a random one never names a run another page started,
		// such as the one this page replaced. A reload or a closed window
		// stops every run of the page before it.
		const request = crypto.randomUUID();
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
				// The shell sends it to the origin the command names.
				options.credential?.authorization ?? null,
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
