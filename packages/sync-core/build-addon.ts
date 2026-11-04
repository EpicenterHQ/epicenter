/**
 * Build the Node-API addon (release) and place it at `sync_core.node`
 * beside this file. `bun packages/sync-core/build-addon.ts [--debug]`.
 */
import { copyFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const here = import.meta.dir;
const release = !process.argv.includes('--debug');
const built = Bun.spawnSync(
	['cargo', 'build', ...(release ? ['--release'] : []), '-p', 'epicenter-sync-core-napi'],
	{ cwd: here, stdout: 'inherit', stderr: 'inherit' },
);
if (built.exitCode !== 0) process.exit(built.exitCode ?? 1);
const extension = process.platform === 'darwin' ? 'dylib' : process.platform === 'win32' ? 'dll' : 'so';
const prefix = process.platform === 'win32' ? '' : 'lib';
const from = join(here, 'target', release ? 'release' : 'debug', `${prefix}epicenter_sync_core_napi.${extension}`);
const to = join(here, 'sync_core.node');
copyFileSync(from, to);
console.log(`${to}: ${(statSync(to).size / 1024 / 1024).toFixed(2)} MiB`);
