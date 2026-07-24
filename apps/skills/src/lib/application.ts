import { skillsWorkspace } from '@epicenter/skills';
import type { Workspace, WorkspaceLens } from '@epicenter/workspace/sqlite';
import { createDeviceBrowserWorkspaceRuntime } from '@epicenter/workspace/sqlite/browser';
import { createSkillsState } from './state/skills-state.svelte.js';

type SkillsWorkspace = Workspace<typeof skillsWorkspace>;

type ApplicationRuntime = {
	open<TDefinition extends WorkspaceLens>(
		definition: TDefinition,
	): Promise<Workspace<TDefinition>>;
	[Symbol.asyncDispose](): Promise<void>;
};

export type SkillsDependencies = {
	createRuntime(
		onRecordsChanged: (workspaceId: string) => void,
	): ApplicationRuntime;
	reportBackgroundError(cause: unknown): void;
};

export type SkillsApplication = SkillsWorkspace & {
	state: ReturnType<typeof createSkillsState>;
	[Symbol.asyncDispose](): Promise<void>;
};

/** Inert browser dependencies. Storage opens only when the root calls open. */
export const skillsBrowser: Pick<SkillsDependencies, 'createRuntime'> = {
	createRuntime: (onRecordsChanged) =>
		createDeviceBrowserWorkspaceRuntime({ onRecordsChanged }),
};

/** Open one fully acquired and hydrated standalone Skills application. */
export async function openSkillsApplication(
	{ createRuntime, reportBackgroundError }: SkillsDependencies,
	{ signal }: { signal?: AbortSignal } = {},
): Promise<SkillsApplication> {
	const recordsChangedListeners = new Set<() => void>();
	const runtime = createRuntime((workspaceId) => {
		if (workspaceId !== skillsWorkspace.id) return;
		for (const listener of recordsChangedListeners) listener();
	});
	let state: ReturnType<typeof createSkillsState> | undefined;
	let releasePromise: Promise<void> | undefined;
	const release = (): Promise<void> => {
		releasePromise ??= (async () => {
			signal?.removeEventListener('abort', onAbort);
			recordsChangedListeners.clear();
			const failures: unknown[] = [];
			try {
				state?.[Symbol.dispose]();
			} catch (cause) {
				failures.push(cause);
			}
			try {
				await runtime[Symbol.asyncDispose]();
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
		const workspace = await untilAbort(runtime.open(skillsWorkspace));
		signal?.throwIfAborted();
		state = createSkillsState({
			skills: workspace,
			onRecordsChanged(listener) {
				recordsChangedListeners.add(listener);
				return () => recordsChangedListeners.delete(listener);
			},
		});
		await untilAbort(state.whenReady);
		signal?.throwIfAborted();
		return Object.freeze({
			...workspace,
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
