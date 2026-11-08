/** Git operations on one app repository. Paths stay as arguments, never shell text. */
export async function git(folder: string, ...args: string[]) {
	const child = Bun.spawn(['git', '-C', folder, ...args], {
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).arrayBuffer(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout: Buffer.from(stdout), stderr: stderr.trim(), code };
}

/** The commit `rev` names, or `null` when it names none (an unborn branch, no merge in progress). */
export async function revParse(folder: string, rev: string) {
	const found = await git(folder, 'rev-parse', '-q', '--verify', rev);
	return found.code === 0 ? found.stdout.toString().trim() : null;
}

export async function checkedGit(folder: string, ...args: string[]) {
	const result = await git(folder, ...args);
	if (result.code !== 0)
		throw new Error(
			result.stderr ||
				result.stdout.toString().trim() ||
				`git ${args[0]} failed`,
		);
	return result.stdout;
}
