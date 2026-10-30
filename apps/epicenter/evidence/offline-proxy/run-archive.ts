import { join } from 'node:path';

const directory = import.meta.dir;
const result = Bun.spawnSync(
	['swift', join(directory, 'archive-probe.swift'), directory],
	{
		cwd: directory,
		env: { ...process.env, EPICENTER_PROBE_BUN: process.execPath },
		stdout: 'pipe',
		stderr: 'pipe',
	},
);
process.stdout.write(result.stdout);
process.stderr.write(result.stderr);
if (result.exitCode !== 0) process.exit(result.exitCode);
