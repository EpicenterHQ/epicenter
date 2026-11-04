/**
 * Build the Node-API addon and place it at `epicenter_core.node` beside
 * `index.ts`: `bun run --cwd packages/epicenter-core build [--debug]`. The
 * CLI's `compile` and `test` scripts run it first. Set `CARGO` to choose the
 * cargo that builds it.
 */
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const release = !process.argv.includes('--debug');
const built = Bun.spawnSync(
	[
		process.env.CARGO ?? 'cargo',
		'build',
		...(release ? ['--release'] : []),
		'-p',
		'epicenter-core-napi',
	],
	{ cwd: join(here, '..'), stdout: 'inherit', stderr: 'inherit' },
);
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);
const extension =
	process.platform === 'darwin'
		? 'dylib'
		: process.platform === 'win32'
			? 'dll'
			: 'so';
const prefix = process.platform === 'win32' ? '' : 'lib';
const from = join(
	here,
	'..',
	'target',
	release ? 'release' : 'debug',
	`${prefix}epicenter_core_napi.${extension}`,
);
const to = join(here, 'epicenter_core.node');
copyFileSync(from, to);
console.log(`${to}: ${(statSync(to).size / 1024 / 1024).toFixed(2)} MiB`);
