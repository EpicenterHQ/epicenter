#!/usr/bin/env bun
/**
 * Remove the built pages before composing a fresh desktop build, so a page
 * that no longer builds leaves nothing behind for the shell to serve. The
 * committed `.gitkeep` stays: Tauri's build requires the bundled `dist`
 * resource directory to exist.
 */

import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const dist = join(import.meta.dir, '..', 'dist');
const entries = await readdir(dist).catch(() => []);
await Promise.all(
	entries
		.filter((entry) => entry !== '.gitkeep')
		.map((entry) => rm(join(dist, entry), { recursive: true, force: true })),
);
