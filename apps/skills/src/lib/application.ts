import type { EpicenterRuntime } from '@epicenter/data/runtime';
import { openBrowserEpicenter } from '@epicenter/data/runtime/browser';
import { type SkillsData, skillsLens } from '@epicenter/skills';
import { createSkillsState } from './state/skills-state.svelte.js';

type ApplicationRuntime = Pick<
	EpicenterRuntime,
	'bind' | typeof Symbol.asyncDispose
>;

export type SkillsDependencies = {
	openEpicenter(): Promise<ApplicationRuntime>;
	reportBackgroundError(cause: unknown): void;
};

export type SkillsApplication = SkillsData & {
	state: ReturnType<typeof createSkillsState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Inert browser dependencies. Storage opens only when the root calls open. */
export const skillsBrowser: Pick<SkillsDependencies, 'openEpicenter'> = {
	openEpicenter: () => openBrowserEpicenter({ owner: null }),
};

/** Open one fully acquired and hydrated standalone Skills application. */
export async function openSkillsApplication(
	{ openEpicenter, reportBackgroundError }: SkillsDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<SkillsApplication> {
	let runtime: ApplicationRuntime | undefined;
	let state: ReturnType<typeof createSkillsState> | undefined;
	let unsubscribeSkills: (() => void) | undefined;
	let unsubscribeReferences: (() => void) | undefined;
	let released = false;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			released = true;
			signal?.removeEventListener('abort', onAbort);
			unsubscribeSkills?.();
			unsubscribeReferences?.();
			const failures: unknown[] = [];
			try {
				state?.[Symbol.dispose]();
			} catch (cause) {
				failures.push(cause);
			}
			try {
				await runtime?.[Symbol.asyncDispose]();
			} catch (cause) {
				failures.push(cause);
			}
			if (failures.length > 0) {
				throw new AggregateError(failures, 'Skills application cleanup failed');
			}
		})();
		return releasePromise;
	};
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => {
		aborted.reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
		void release().catch(reportBackgroundError);
	};
	signal?.addEventListener('abort', onAbort, { once: true });
	const untilAbort = <TValue>(work: Promise<TValue>): Promise<TValue> =>
		signal ? Promise.race([work, aborted.promise]) : work;

	try {
		signal?.throwIfAborted();
		const opened = await untilAbort(
			openEpicenter().then(async (value) => {
				runtime = value;
				if (released) await value[Symbol.asyncDispose]();
				return value;
			}),
		);
		const data = opened.bind(skillsLens);
		signal?.throwIfAborted();
		state = createSkillsState({ skills: data });
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		const refresh = () => void state?.refresh();
		unsubscribeSkills = data.skills.subscribe(refresh);
		unsubscribeReferences = data.references.subscribe(refresh);
		return Object.freeze({
			...data,
			state,
			[Symbol.asyncDispose]: release,
		});
	} catch (cause) {
		try {
			await release();
		} catch (releaseCause) {
			throw new AggregateError(
				[cause, releaseCause],
				'Skills application acquisition and cleanup failed',
			);
		}
		throw cause;
	}
}
