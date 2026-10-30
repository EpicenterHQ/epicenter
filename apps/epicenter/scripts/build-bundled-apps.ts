#!/usr/bin/env bun
/**
 * Build the apps Epicenter bundles into `dist/<page>/`, where the shell
 * serves each at `epicenter-app://localhost/<page>/` (`BundledApp` in
 * `src-tauri/src/bundled_apps.rs`).
 *
 * Each runs its own host build in `apps/<page>` (`build:host`, which sets
 * `EPICENTER_HOST=1`), which writes a single-page app with relative asset
 * paths to `apps/<page>/dist/`, and that output is copied here. The build
 * consumes the canonical app source: nothing is cloned, approved, or fetched.
 *
 * With page names as arguments it builds only those.
 */

import { cp, rm } from 'node:fs/promises';
import { join } from 'node:path';

/** Every `BundledApp` page, in the table's order. */
export const BUNDLED_PAGES = [
	'todos',
	'capture',
	'honeycrisp',
	'whispering',
	'messages',
] as const;

export type BundledPage = (typeof BUNDLED_PAGES)[number];

const appsDir = join(import.meta.dir, '..', '..');
const distDir = join(import.meta.dir, '..', 'dist');

/** Build `page` from `apps/<page>` and copy it to `dist/<page>/`. */
export async function buildBundledPage(page: BundledPage): Promise<void> {
	const source = join(appsDir, page);
	const build = Bun.spawn(['bun', 'run', 'build:host'], {
		cwd: source,
		stdout: 'inherit',
		stderr: 'inherit',
	});
	const code = await build.exited;
	if (code !== 0) throw new Error(`${page}'s build:host exited with ${code}`);

	const served = join(distDir, page);
	await rm(served, { recursive: true, force: true });
	await cp(join(source, 'dist'), served, { recursive: true });
}

function isBundledPage(page: string): page is BundledPage {
	return (BUNDLED_PAGES as readonly string[]).includes(page);
}

if (import.meta.main) {
	const asked = process.argv.slice(2);
	const unknown = asked.filter((page) => !isBundledPage(page));
	if (unknown.length > 0) {
		console.error(
			`Not a bundled app: ${unknown.join(', ')}. Bundled apps: ${BUNDLED_PAGES.join(', ')}.`,
		);
		process.exit(2);
	}
	const pages = asked.length > 0 ? asked.filter(isBundledPage) : BUNDLED_PAGES;
	for (const page of pages) {
		try {
			await buildBundledPage(page);
		} catch (error) {
			console.error(error instanceof Error ? error.message : String(error));
			process.exit(1);
		}
	}
}
