/** A plain Git helper configured only inside integration tests' temporary homes. */

/** One argument for `sh`, single-quoted: Git runs a `!` credential helper through the shell. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

export function configureTestGitHelper(
	origin: string,
	command: readonly string[],
	env: Record<string, string | undefined>,
) {
	const key = `credential.${new URL(origin).origin}.helper`;
	const helper = `!${command.map(shellQuote).join(' ')} auth git-credential`;
	for (const value of ['', helper]) {
		const result = Bun.spawnSync(
			['git', 'config', '--global', '--add', key, value],
			{
				env,
			},
		);
		if (result.exitCode !== 0)
			throw new Error(result.stderr.toString() || 'Git helper fixture failed');
	}
}
