/**
 * What a command that runs an action answers (ADR-0850): the one value
 * `--json` prints, MCP returns as `structuredContent`, and stderr renders.
 * The run commits nothing, so the answer is only what the action did, or why
 * nothing ran.
 */
export type Answer =
	/** The action returned this value; `null` for nothing. */
	| { returned: unknown }
	/**
	 * The action threw, or the run ended without an answer. A thrown tagged
	 * error (`{ name, message, ...fields }`) is kept whole as `thrown`.
	 */
	| { threw: { message: string; thrown?: Record<string, unknown> } }
	/** Nothing ran: the words, the input, or the app was wrong. */
	| { error: { name: string; message: string; next?: string } };

/** 0: it returned. 1: it threw, or ended without an answer. 2: it did not run. */
export function exitCodeOf(answer: Answer): 0 | 1 | 2 {
	if ('error' in answer) return 2;
	return 'threw' in answer ? 1 : 0;
}
