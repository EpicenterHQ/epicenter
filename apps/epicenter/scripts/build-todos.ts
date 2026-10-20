#!/usr/bin/env bun
/**
 * Build Todos, which Epicenter bundles, into `dist/todos/`, where the shell
 * serves it at `epicenter-app://localhost/todos/` (`src-tauri/src/todos.rs`).
 *
 * It runs Todos' own installed build in `apps/todos` (`build:installed`),
 * which writes a single-page app with relative asset paths to
 * `apps/todos/dist/`, and copies that output here. The build consumes the
 * canonical app source: nothing is cloned and no `epicenter.app.json` is
 * read.
 */

import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

const todosDir = join(import.meta.dir, '..', '..', 'todos');
const served = join(import.meta.dir, '..', 'dist', 'todos');

const build = Bun.spawn(['bun', 'run', 'build:installed'], {
	cwd: todosDir,
	stdout: 'inherit',
	stderr: 'inherit',
});
const code = await build.exited;
if (code !== 0) process.exit(code);

await rm(served, { recursive: true, force: true });
await cp(join(todosDir, 'dist'), served, { recursive: true });
