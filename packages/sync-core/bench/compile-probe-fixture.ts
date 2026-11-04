/**
 * Set up a folder and a bare remote where the remote and the folder both
 * made `n.md`, so the compiled probe's round runs `settle` once.
 * Prints the probe's two arguments.
 */
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..', 'test', 'fixture-probe');
rmSync(root, { recursive: true, force: true });
const run = (cwd: string, ...cmd: string[]) => {
	const ran = Bun.spawnSync(cmd, { cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
	if (ran.exitCode !== 0) throw new Error(ran.stderr.toString());
};
for (const dir of ['seed', 'folder']) mkdirSync(join(root, dir), { recursive: true });
run(root, 'git', 'init', '-q', '--bare', '-b', 'main', 'remote.git');
const seed = join(root, 'seed');
run(seed, 'git', 'init', '-q', '-b', 'main');
writeFileSync(join(seed, 'n.md'), '---\ntitle: Remote\n---\nfrom the remote\n');
run(seed, 'git', 'add', 'n.md');
run(seed, 'git', '-c', 'user.name=r', '-c', 'user.email=r@x', 'commit', '-qm', 'seed');
run(seed, 'git', 'push', '-q', '../remote.git', 'main');
writeFileSync(join(root, 'folder', 'n.md'), '---\ntitle: Local\n---\nfrom here\n');
console.log(`${join(root, 'folder')} file://${join(root, 'remote.git')}`);
