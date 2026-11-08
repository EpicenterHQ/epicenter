/**
 * The command's answers and failures (ADR-0842): stdout carries the answer,
 * stderr explains a problem to a person. Exit codes and the error's code and
 * next tell a caller whether an action ran and what to do next.
 */
/** Exit codes distinguish refused input from an action that started and threw. */
export const EXIT = { ok: 0, finding: 1, unusable: 2, failed: 3 } as const;

export type CliError = {
	code: 'usage' | 'failed' | 'needs_person';
	message: string;
	next?: string;
};

/** Write one JSON answer per line so callers can read stdout directly. */
export function writeJson(value: unknown) {
	process.stdout.write(`${JSON.stringify(value)}\n`);
}

/** Write an answer with a final newline for a person reading the command. */
export function writeOut(text: string) {
	process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Write diagnostics separately from the answer or MCP protocol. */
export function writeErr(text: string) {
	process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}

/** Present a refusal or action failure and return its exit code without forcing exit. */
export function fail(error: CliError, json: boolean): number {
	if (json) writeJson({ error });
	else {
		writeErr(error.message);
		if (error.next) writeErr(`Run: ${error.next}`);
	}
	return error.code === 'failed' ? EXIT.failed : EXIT.unusable;
}
