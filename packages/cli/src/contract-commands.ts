/**
 * `check` and `format`: a folder against an app's contract, taken as a URL
 * or a file path (decision 35: folders hold no `epicenter.json`). The
 * checking and formatting live in `@epicenter/folder/node`.
 */
import { readFile } from 'node:fs/promises';
import { checkFiles, formatNotes } from '@epicenter/folder/node';
import { count, EXIT, fail, writeJson, writeOut } from './output.ts';

/** The contract at `source`, a URL or a file path, parsed as JSON; or why it cannot be read. */
async function readContract(
	source: string,
): Promise<{ contract: unknown } | { error: string }> {
	let text: string;
	try {
		if (/^https?:\/\//.test(source)) {
			const response = await fetch(source);
			if (!response.ok)
				return {
					error: `The contract at ${source} could not be fetched: ${response.status} ${response.statusText}`,
				};
			text = await response.text();
		} else text = await readFile(source, 'utf8');
	} catch (cause) {
		return {
			error: `The contract at ${source} could not be read: ${cause instanceof Error ? cause.message : String(cause)}`,
		};
	}
	try {
		return { contract: JSON.parse(text) };
	} catch (cause) {
		return {
			error: `The contract at ${source} is not JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
		};
	}
}

export async function check(source: string, dir: string, json: boolean) {
	const read = await readContract(source);
	if ('error' in read) return fail(read.error, json);
	const { data, error } = await checkFiles(read.contract, { path: dir });
	if (error !== null) return fail(error.message, json);
	const { files, issues } = data;
	const exitCode = issues.length > 0 ? EXIT.finding : EXIT.ok;
	if (json) {
		writeJson({ files, issues, exitCode });
		return exitCode;
	}
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
	return exitCode;
}

export async function format(source: string, dir: string, json: boolean) {
	const read = await readContract(source);
	if ('error' in read) return fail(read.error, json);
	const { data, error } = await formatNotes(read.contract, { path: dir });
	if (error !== null) return fail(error.message, json);
	const { formatted, unchanged, refused } = data;
	const exitCode = refused.length > 0 ? EXIT.finding : EXIT.ok;
	if (json) {
		writeJson({ formatted, unchanged, refused, exitCode });
		return exitCode;
	}
	writeOut(
		[
			...formatted.map((path) => `formatted ${path}`),
			...refused.map(({ path, reason }) => `${path}: ${reason}`),
			`${count(formatted.length, 'note')} formatted; ${unchanged} already in house style; ${refused.length} left as they are.`,
		].join('\n'),
	);
	return exitCode;
}
