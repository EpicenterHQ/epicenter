import type { Options } from 'yargs';

const outputFormats = ['json', 'jsonl'] as const;
export type OutputFormat = (typeof outputFormats)[number];

type FormatOptions = {
	/** Override format (default: json, auto-pretty for TTY) */
	format?: OutputFormat;
};

/** Format a single value as JSON: pretty on TTY unless `format: 'jsonl'`. */
function formatJson(value: unknown, { format }: FormatOptions = {}): string {
	const shouldPretty = format !== 'jsonl' && (process.stdout.isTTY ?? false);
	return JSON.stringify(value, null, shouldPretty ? 2 : undefined);
}

/** Format an array as JSONL: one JSON value per line. */
function formatJsonl(values: unknown[]): string {
	return values.map((v) => JSON.stringify(v)).join('\n');
}

/** Output data to stdout with appropriate formatting. */
export function output(value: unknown, { format }: FormatOptions = {}): void {
	if (format === 'jsonl') {
		const rows = Array.isArray(value) ? value : [value];
		console.log(formatJsonl(rows));
	} else {
		console.log(formatJson(value, { format }));
	}
}

/**
 * Emit one error to stderr and set the process exit code. The single owner of
 * CLI error output: every command routes failures through here so the `error:`
 * prefix, the target stream, and the exit code are decided in one place. New
 * commands stay consistent by calling this instead of open-coding console.error.
 *
 * `details` are extra stderr lines printed verbatim under the prefixed line,
 * such as suggestion lists or a follow-up hint.
 */
export function fail(
	message: string,
	{ code = 1, details = [] }: { code?: number; details?: string[] } = {},
): void {
	console.error(`error: ${message}`);
	for (const line of details) console.error(line);
	process.exitCode = code;
}

/** Yargs options for the shared format flag. */
export const formatOptions = {
	format: {
		type: 'string',
		choices: outputFormats,
		description: 'Output format (default: json, auto-pretty for TTY)',
	},
} satisfies Record<'format', Options>;
