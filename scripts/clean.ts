#!/usr/bin/env bun

/**
 * @fileoverview Clean script for Epicenter monorepo
 *
 * Removes build artifacts, caches, and node_modules across the monorepo.
 *
 * Usage:
 *   bun run clean        # Remove build artifacts, caches, node_modules
 *   bun run clean --nuke # Above + Rust targets (full reset)
 */

import { rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { workspaces } from '../package.json';

const isNuke = process.argv.includes('--nuke');

const subDirs = [
	// Build outputs
	'.svelte-kit',
	'.astro',
	'.wxt',
	'.output',
	'.vercel',
	'.build',
	'dist',
	// Caches
	'.wrangler',
	'.mf',
	// Tauri generated files (no-op for non-Tauri workspaces)
	'src-tauri/gen',
	// Dependencies (includes nested caches like node_modules/.vite)
	'node_modules',
	// Nuke-only: Rust compilation cache (several GB, takes minutes to rebuild)
	...(isNuke ? ['src-tauri/target'] : []),
] as const;

async function main() {
	console.log(
		isNuke
			? '💥 NUKE MODE: Cleaning everything including Rust target...\n\n⚠️  Warning: Rust recompilation will take several minutes!\n'
			: '🧹 Cleaning Epicenter monorepo...\n',
	);

	// Discover all monorepo package roots from workspace config
	const packageRoots = workspaces.packages.flatMap((pattern) =>
		[...new Bun.Glob(join(pattern, 'package.json')).scanSync()].map(dirname),
	);

	const dirsToRemove = [
		'node_modules',
		...packageRoots.flatMap((root) =>
			subDirs.map((subDir) => join(root, subDir)),
		),
	];

	// Clean repo directories
	console.log('Removing build artifacts and node_modules...');
	await Promise.all(
		dirsToRemove.map((path) => rm(path, { recursive: true, force: true })),
	);
	console.log(`  ✓ Processed ${dirsToRemove.length} directories\n`);

	console.log('✨ Clean complete!\n');

	// Reinstall dependencies
	console.log('📦 Installing dependencies...\n');
	await Bun.spawn(['bun', 'install'], {
		stdio: ['inherit', 'inherit', 'inherit'],
	}).exited;
}

main().catch(console.error);
