/**
 * Skills' App and UI state share one lifetime. The route still awaits a product
 * decision about authentication; callers that hold an Account use the same
 * current-library opening path as the store applications.
 */
import { openApp } from '@epicenter/app/open';
import type { Account } from '@epicenter/auth';
import { skillsDefinition } from '@epicenter/skills';
import { createSkillsState } from './state/skills-state.svelte.js';

/** Open the captured account's current Personal library before creating UI state. */
export async function openSkillsRuntime({
	account,
	signal,
}: {
	account: Account;
	signal?: AbortSignal;
}) {
	signal?.throwIfAborted();
	const app = openApp(skillsDefinition, { account });
	try {
		const ready = await app.ready;
		if (ready.error) throw ready.error;
		signal?.throwIfAborted();
		const data = app.account!.personal;
		const state = createSkillsState({ data });
		let stateClosed = false;
		return Object.freeze({
			data,
			state,
			async [Symbol.asyncDispose]() {
				try {
					if (!stateClosed) {
						stateClosed = true;
						state[Symbol.dispose]();
					}
				} finally {
					await app.close();
				}
			},
		});
	} catch (cause) {
		await app.close().catch(() => undefined);
		throw cause;
	}
}

export type SkillsRuntime = Awaited<ReturnType<typeof openSkillsRuntime>>;
