import { invoke } from '@tauri-apps/api/core';
import { defineErrors, type InferErrors } from 'wellcrafted/error';
import { Ok, type Result } from 'wellcrafted/result';

export const RuntimeTranscriptionError = defineErrors({
	Cancelled: () => ({ message: 'Native transcription was cancelled.' }),
	RequestFailed: ({ cause }: { cause: unknown }) => ({
		message: 'The native transcription request failed.',
		cause,
	}),
	InvalidResponse: () => ({
		message: 'The native transcription provider returned an invalid response.',
	}),
});
export type RuntimeTranscriptionError = InferErrors<
	typeof RuntimeTranscriptionError
>;
export type RuntimeModel = { id: string; installed: true; active: boolean };
export type RuntimeTranscript = {
	text: string;
	model?: string;
	applied?: { language: string | null; initialPrompt: boolean };
};

/** Validated IPC owns admission and delivery; Rust owns admitted blocking compute. */
export function createRuntimeTranscriber(
	send: (
		command: string,
		args?: Record<string, unknown>,
	) => Promise<unknown> = invoke,
) {
	const lifetime = new AbortController();
	const pending = new Set<Promise<unknown>>();
	let closing: Promise<void> | undefined;
	function run<T>(
		signal: AbortSignal | undefined,
		operation: (
			signal: AbortSignal,
		) => Promise<Result<T, RuntimeTranscriptionError>>,
	) {
		const combined = signal
			? AbortSignal.any([lifetime.signal, signal])
			: lifetime.signal;
		if (combined.aborted)
			return Promise.resolve(RuntimeTranscriptionError.Cancelled());
		const work = operation(combined);
		pending.add(work);
		void work.then(
			() => pending.delete(work),
			() => pending.delete(work),
		);
		return work;
	}
	async function call(
		command: string,
		args: Record<string, unknown> | undefined,
		signal: AbortSignal,
	): Promise<Result<unknown, RuntimeTranscriptionError>> {
		if (signal.aborted) return RuntimeTranscriptionError.Cancelled();
		try {
			const result = await send(command, args);
			return signal.aborted
				? RuntimeTranscriptionError.Cancelled()
				: Ok(result);
		} catch (cause) {
			return signal.aborted
				? RuntimeTranscriptionError.Cancelled()
				: RuntimeTranscriptionError.RequestFailed({ cause });
		}
	}
	return Object.freeze({
		identity: 'native-transcription',
		signal: lifetime.signal,
		/** IDs come from the host catalog; an empty list means no models are installed. */
		listModels({ signal }: { signal?: AbortSignal } = {}) {
			return run<RuntimeModel[]>(signal, async (signal) => {
				const result = await call('list_inference_models', undefined, signal);
				if (result.error) return result;
				const models = result.data;
				if (
					!Array.isArray(models) ||
					!models.every(
						(model: unknown) =>
							typeof model === 'object' &&
							model !== null &&
							'id' in model &&
							typeof model.id === 'string' &&
							model.id.trim() &&
							'installed' in model &&
							model.installed === true &&
							'active' in model &&
							typeof model.active === 'boolean',
					)
				)
					return RuntimeTranscriptionError.InvalidResponse();
				return Ok(models as RuntimeModel[]);
			});
		},
		/** Run an exact ID from listModels without changing the host active model. */
		transcribe(
			{
				audio,
				model,
				language,
				prompt,
			}: { audio: Blob; model: string; language?: string; prompt?: string },
			{ signal }: { signal?: AbortSignal } = {},
		) {
			if (
				!(audio instanceof Blob) ||
				typeof model !== 'string' ||
				!model.trim() ||
				(language !== undefined && typeof language !== 'string') ||
				(prompt !== undefined && typeof prompt !== 'string')
			)
				throw new TypeError(
					'Native transcription requires audio, an exact model, and string hints.',
				);
			return run<RuntimeTranscript>(signal, async (signal) => {
				const bytes = Array.from(new Uint8Array(await audio.arrayBuffer()));
				const result = await call(
					'transcribe_audio_bytes',
					{
						modelId: model,
						bytes,
						hints: {
							language: language ?? null,
							initialPrompt: prompt ?? null,
						},
					},
					signal,
				);
				if (result.error) return result;
				const value = result.data;
				if (
					typeof value !== 'object' ||
					value === null ||
					!('outcome' in value)
				)
					return RuntimeTranscriptionError.InvalidResponse();
				if (value.outcome === 'empty-audio') return Ok({ text: '' });
				if (
					value.outcome !== 'transcribed' ||
					!('text' in value) ||
					typeof value.text !== 'string' ||
					!('modelId' in value) ||
					value.modelId !== model ||
					!('applied' in value) ||
					typeof value.applied !== 'object' ||
					value.applied === null ||
					!('language' in value.applied) ||
					(value.applied.language !== null &&
						typeof value.applied.language !== 'string') ||
					!('initialPrompt' in value.applied) ||
					typeof value.applied.initialPrompt !== 'boolean'
				)
					return RuntimeTranscriptionError.InvalidResponse();
				return Ok({
					text: value.text,
					model: value.modelId,
					applied: {
						language: value.applied.language,
						initialPrompt: value.applied.initialPrompt,
					},
				});
			});
		},
		close(): Promise<void> {
			if (closing) return closing;
			const completion = Promise.withResolvers<void>();
			closing = completion.promise;
			lifetime.abort();
			// Never race IPC against abort: this handle settles only after host work.
			void Promise.allSettled(pending).then((results) => {
				const failures = results.flatMap((result) =>
					result.status === 'rejected' ? [result.reason] : [],
				);
				if (failures.length)
					completion.reject(
						new AggregateError(
							failures,
							'Native transcription cleanup failed.',
						),
					);
				else completion.resolve();
			});
			return closing;
		},
	});
}
export type RuntimeTranscriber = ReturnType<typeof createRuntimeTranscriber>;
