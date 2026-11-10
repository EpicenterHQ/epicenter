/**
 * What a command that runs an action answers (ADR-0850): the one value
 * `--json` prints, MCP returns as `structuredContent`, and stderr renders.
 * A run that returned from an action that writes commits what changed in
 * the app's folder, and the answer says which commit, or why there is none.
 */
export type Answer =
	/**
	 * The action returned this value; `null` for nothing. `committed` is the
	 * commit its writes made; `uncommitted` says why they were left in the
	 * folder when committing failed.
	 */
	| {
			returned: unknown;
			committed?: string;
			uncommitted?: { message: string; next: string };
	  }
	/**
	 * The action threw, or the run ended without an answer. A thrown tagged
	 * error (`{ name, message, ...fields }`) is kept whole as `thrown`.
	 */
	| { threw: { message: string; thrown?: Record<string, unknown> } }
	/** Nothing ran: the words, the input, or the app was wrong. */
	| { error: { name: string; message: string; next?: string } };

/**
 * 0: it returned, and its writes are committed or there were none. 1: it
 * threw, or ended without an answer. 2: it did not run. 3: it returned, and
 * its writes are not committed, so running it again would repeat them
 * (ADR-0867).
 */
export function exitCodeOf(answer: Answer): 0 | 1 | 2 | 3 {
	if ('error' in answer) return 2;
	if ('threw' in answer) return 1;
	return answer.uncommitted ? 3 : 0;
}
