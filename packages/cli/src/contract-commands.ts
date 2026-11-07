/**
 * `check` and `format`: a folder against its contract, its own
 * `epicenter.json` (ADR-0805), or an app's named by `--contract` as a URL or
 * a file path. The checking and formatting live in `@epicenter/folder/node`.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { CONTRACT_PATH } from '@epicenter/definition/contract';
import { checkFiles, formatNotes } from '@epicenter/folder/node';
import { Err, Ok, type Result } from 'wellcrafted/result';
import type { ImplementationOf } from './operation.ts';
import type {
	check as checkOperation,
	format as formatOperation,
} from './operations.ts';
import { count, EXIT, writeOut } from './output.ts';

/** The contract at `source`, a URL or a file path, parsed as JSON; or why it cannot be read. */
async function readContract(source: string): Promise<Result<unknown, string>> {
	let text: string;
	try {
		if (/^https?:\/\//.test(source)) {
			const response = await fetch(source);
			if (!response.ok)
				return Err(
					`The contract at ${source} could not be fetched: ${response.status} ${response.statusText}`,
				);
			text = await response.text();
		} else text = await readFile(source, 'utf8');
	} catch (cause) {
		return Err(
			`The contract at ${source} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
	try {
		return Ok(JSON.parse(text));
	} catch (cause) {
		return Err(
			`The contract at ${source} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
		);
	}
}

/** The contract `source` names, or else the folder's own `epicenter.json`. */
const contractFor = (folder: string, source: string | undefined) =>
	readContract(source ?? join(folder, CONTRACT_PATH));

export const check: ImplementationOf<typeof checkOperation> = {
	async run({ dir = '.', contract }) {
		const read = await contractFor(dir, contract);
		if (read.error !== null) return read;
		const { data, error } = await checkFiles(read.data, { path: dir });
		if (error !== null) return Err(error.message);
		const { files, issues } = data;
		const exitCode = issues.length > 0 ? EXIT.finding : EXIT.ok;
		return Ok({
			output: { files, issues, exitCode },
			finding: exitCode === EXIT.finding,
		});
	},
	print({ files, issues }) {
		const invalid = new Set(issues.map(({ path }) => path)).size;
		writeOut(
			[
				...issues.map(
					({ path, line, message }) =>
						`${line === undefined ? path : `${path}:${line}`}: ${message}`,
				),
				`${count(files - invalid, 'file')} ${files - invalid === 1 ? 'fits' : 'fit'}; ${count(invalid, 'file')} ${invalid === 1 ? 'does' : 'do'} not.`,
			].join('\n'),
		);
	},
};

export const format: ImplementationOf<typeof formatOperation> = {
	async run({ dir = '.', contract }) {
		const read = await contractFor(dir, contract);
		if (read.error !== null) return read;
		const { data, error } = await formatNotes(read.data, { path: dir });
		if (error !== null) return Err(error.message);
		const { formatted, unchanged, refused } = data;
		const exitCode = refused.length > 0 ? EXIT.finding : EXIT.ok;
		return Ok({
			output: { formatted, unchanged, refused, exitCode },
			finding: exitCode === EXIT.finding,
		});
	},
	print({ formatted, unchanged, refused }) {
		writeOut(
			[
				...formatted.map((path) => `formatted ${path}`),
				...refused.map(({ path, reason }) => `${path}: ${reason}`),
				`${count(formatted.length, 'note')} formatted; ${unchanged} already in house style; ${refused.length} left as they are.`,
			].join('\n'),
		);
	},
};
