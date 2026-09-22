#!/usr/bin/env -S bun --no-install
/** Validate working files using trusted executable config. The validator makes no writes. */
import { Console } from 'node:console';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseRowFile } from '../packages/app/src/data/artifact/frontmatter.js';
import {
	compileData,
	type ParsedTable,
} from '../packages/app/src/data/definition/compile.js';
import {
	isJsonObject,
	type JsonObject,
} from '../packages/app/src/data/definition/json.js';

const usage = 'Usage: epicenter validate <folder> [--json]';

async function validateFolder(path: string) {
	const root = resolve(path);
	const configPath = join(root, 'epicenter.config.ts');
	const issues: { path: string; field: string; message: string }[] = [];
	const errors: { path: string; message: string }[] = [];
	let checkedFiles = 0;
	const result = () => ({
		config: configPath,
		checkedFiles,
		issues,
		errors,
		exitCode: errors.length ? 2 : issues.length ? 1 : 0,
	});
	async function read(path: string) {
		return new TextDecoder('utf-8', { fatal: true }).decode(
			await readFile(path),
		);
	}
	function failure(path: string, error: unknown) {
		errors.push({
			path,
			message: error instanceof Error ? error.message : String(error),
		});
	}
	function check(
		path: string,
		table: ParsedTable,
		values: JsonObject,
		row: boolean,
	) {
		// Row omission spells null. The actual field check decides whether null conforms.
		const input = { ...values };
		if (row)
			for (const field of table.fields.values()) {
				if (!Object.hasOwn(input, field.name)) input[field.name] = null;
			}
		for (const issue of table.conformance(input).issues)
			issues.push({ path, ...issue });
		checkedFiles++;
	}
	// Read first to reject invalid UTF-8 even if the runtime replaces bad bytes.
	await read(configPath);
	const module = await import(pathToFileURL(configPath).href);
	const compiled = compileData(module.default);
	if (compiled.error) throw new Error(compiled.error.message);
	const definition = compiled.data;
	const kvPath = join(root, 'kv.json');
	try {
		const values: unknown = JSON.parse(await read(kvPath));
		if (!isJsonObject(values))
			throw new Error('Expected a JSON object with JSON-compatible values.');
		check('kv.json', definition.kv, values, false);
	} catch (error) {
		failure('kv.json', error);
	}
	for (const [name, table] of definition.tables) {
		let files: string[];
		try {
			files = (await readdir(join(root, name)))
				.filter((file) => file.endsWith('.md'))
				.sort();
		} catch (error) {
			failure(name, error);
			continue;
		}
		for (const file of files) {
			const path = `${name}/${file}`;
			try {
				const parsed = parseRowFile(await read(join(root, path)));
				if (!parsed)
					throw new Error(
						'Expected fenced Markdown frontmatter with JSON-compatible values.',
					);
				check(path, table, parsed.fields, true);
			} catch (error) {
				failure(path, error);
			}
		}
	}
	return result();
}

if (import.meta.main) {
	const json = Bun.argv.slice(2).includes('--json');
	let config: string | undefined;
	// Keep this installed for deferred diagnostics from imported modules too.
	Object.assign(
		globalThis.console,
		new Console({ stdout: process.stderr, stderr: process.stderr }),
	);
	try {
		const { values, positionals } = parseArgs({
			args: Bun.argv.slice(2),
			allowPositionals: true,
			options: {
				json: { type: 'boolean' },
				help: { type: 'boolean', short: 'h' },
			},
		});
		if (values.help) process.stdout.write(`${usage}\n`);
		else if (positionals.length !== 2 || positionals[0] !== 'validate') {
			throw new Error(usage);
		} else {
			config = resolve(positionals[1]!, 'epicenter.config.ts');
			const report = await validateFolder(positionals[1]!);
			process.stdout.write(
				(values.json
					? JSON.stringify(report, null, 2)
					: [
							`Config: ${report.config}`,
							...report.errors.map(
								(error) => `${error.path}: ${error.message}`,
							),
							...report.issues.map(
								(issue) => `${issue.path} [${issue.field}]: ${issue.message}`,
							),
							`${report.checkedFiles} files checked; ${report.issues.length} conformance issues; ${report.errors.length} errors.`,
						].join('\n')) + '\n',
			);
			process.exitCode = report.exitCode;
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (json)
			process.stdout.write(
				`${JSON.stringify({ config, checkedFiles: 0, issues: [], errors: [{ path: config, message }], exitCode: 2 })}\n`,
			);
		else console.error(config ? `${config}: ${message}` : message);
		process.exitCode = 2;
	}
}
