/** Client boundaries keep credential verification on the server and runtime storage private. */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as authRoot from './index.js';

const repoRoot = join(import.meta.dir, '../../..');

const scannedRoots = ['apps', 'packages'];
const skippedSegments = new Set([
	'.git',
	'.svelte-kit',
	'dist',
	'node_modules',
	'target',
]);
const scannedExtensions = new Set([
	'.js',
	'.jsx',
	'.mjs',
	'.mts',
	'.svelte',
	'.ts',
	'.tsx',
]);
const allowedPathPatterns = [
	/^packages\/auth\//,
	/^packages\/server\//,
	/^apps\/api\//,
	/^apps\/self-host\//,
	/\.test\.[cm]?[tj]sx?$/,
	/\.spec\.[cm]?[tj]sx?$/,
	/^apps\/whispering\/src-tauri\//,
];
const forbiddenPatterns = [
	/\bdecodeJwt\b/,
	/\bdecodeJwtPayload\b/,
	/\bjwtVerify\b/,
	/\bcreateRemoteJWKSet\b/,
	/\bfrom\s+['"]jose['"]/,
	/\bfrom\s+['"]jwt-decode['"]/,
	/\bfrom\s+['"]jsonwebtoken['"]/,
	/\boauthProviderResourceClient\b/,
	/\bverifyAccessToken\b/,
];

function walk(dir: string, files: string[] = []): string[] {
	for (const entry of readdirSync(dir)) {
		if (skippedSegments.has(entry)) continue;
		const absolutePath = join(dir, entry);
		const stat = statSync(absolutePath);
		if (stat.isDirectory()) {
			walk(absolutePath, files);
			continue;
		}
		if (!stat.isFile()) continue;
		const extension = absolutePath.match(/\.[^.]+$/)?.[0];
		if (extension && scannedExtensions.has(extension)) files.push(absolutePath);
	}
	return files;
}

function isAllowed(relativePath: string): boolean {
	return allowedPathPatterns.some((pattern) => pattern.test(relativePath));
}

describe('client auth boundary', () => {
	test('app and client packages do not decode or verify JWTs', () => {
		const violations = scannedRoots.flatMap((root) =>
			walk(join(repoRoot, root)).flatMap((absolutePath) => {
				const relativePath = relative(repoRoot, absolutePath);
				if (isAllowed(relativePath)) return [];
				const source = readFileSync(absolutePath, 'utf8');
				return forbiddenPatterns
					.filter((pattern) => pattern.test(source))
					.map((pattern) => `${relativePath}: ${pattern.source}`);
			}),
		);

		expect(violations).toEqual([]);
	});

	test('credential-shaped schemas are not on the public root', () => {
		// PersistedAuth is the durable credential cell; runtimes persist it
		// through the storage adapters, never by importing the schema. Keeping
		// it off the barrel is the structural guard: the package `exports` map
		// exposes no path to `auth-types.js`, so an app cannot reach it at all.
		expect('PersistedAuth' in authRoot).toBe(false);

		// The capability surface stays public.
		expect('createWebStoragePersistedAuthStorage' in authRoot).toBe(true);
		expect('createSessionAuth' in authRoot).toBe(true);
	});
});
