/**
 * Where a command's words go. Stdout is the machine contract: the answer, or
 * with `--json` one JSON value per line. Stderr is for people.
 *
 * Nothing here calls `process.exit`: a pipe can lose output written just
 * before it, so a command returns its exit code and the process ends when
 * stdout has drained.
 */

/** Exit codes (ADR-0520): done, a finding a person acts on, input the tool cannot use. */
export const EXIT = { ok: 0, finding: 1, unusable: 2 } as const;

/** One JSON value as one line, so every `--json` stdout is also NDJSON. */
export function writeJson(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function writeOut(text: string) {
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/**
 * End a command that could not do its work: `{ "error" }` on stdout with
 * `--json`, so a caller reading stdout always gets a value, and the message
 * on stderr otherwise. Returns exit code 2.
 */
export function fail(message: string, json: boolean) {
	if (json) writeJson({ error: message });
	else writeErr(message);
	return EXIT.unusable;
}

export function count(n: number, noun: string) {
	return `${n} ${noun}${n === 1 ? '' : 's'}`;
}
