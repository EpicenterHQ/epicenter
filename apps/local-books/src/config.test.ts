/**
 * `config.json` is optional, but a present one is read whole or refused. A
 * field that does not read is reported by name; the file is never dropped in
 * favor of defaults, because one of its fields is the read-only safety posture.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from './config.ts';

const ROOT = 'EPICENTER_DATA_DIR';
let root: string;
let previousRoot: string | undefined;

beforeEach(() => {
	previousRoot = process.env[ROOT];
	root = mkdtempSync(join(tmpdir(), 'lb-config-'));
	process.env[ROOT] = root;
});
afterEach(() => {
	if (previousRoot === undefined) delete process.env[ROOT];
	else process.env[ROOT] = previousRoot;
	rmSync(root, { recursive: true, force: true });
});

/** Write `contents` as Local Books' config.json; returns its path. */
function writeConfig(contents: string): string {
	const dir = join(root, 'apps', 'so.epicenter.local-books');
	mkdirSync(dir, { recursive: true });
	const path = join(dir, 'config.json');
	writeFileSync(path, contents);
	return path;
}

test('without config.json, the defaults hold', () => {
	const config = loadConfig();
	expect(config.readOnly).toBe(false);
	expect(config.pageSize).toBe(1000);
});

test('a valid config.json is read', () => {
	writeConfig(JSON.stringify({ readOnly: true, pageSize: 500 }));
	const config = loadConfig();
	expect(config.readOnly).toBe(true);
	expect(config.pageSize).toBe(500);
});

test('config refuses inherited object keys as entity names', () => {
	writeConfig(
		JSON.stringify({ entities: ['constructor', 'toString', '__proto__'] }),
	);
	expect(() => loadConfig()).toThrow(
		'Unknown entities in config: constructor, toString, __proto__',
	);
});

test('a field that does not read stops loading and is named, so read-only is never dropped', () => {
	const path = writeConfig(JSON.stringify({ readOnly: true, pageSize: '500' }));
	expect(() => loadConfig()).toThrow(`${path}: /pageSize must be number`);
});

test('a config.json that is not JSON stops loading', () => {
	const path = writeConfig('{ "readOnly": true,');
	expect(() => loadConfig()).toThrow(`${path} is not valid JSON`);
});
