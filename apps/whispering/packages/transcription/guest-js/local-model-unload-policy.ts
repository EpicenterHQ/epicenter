/**
 * When to drop the resident local transcription model from memory after the
 * user stops transcribing.
 *
 * Presentation only. The values are the generated `UnloadPolicy` union, so this
 * list cannot name a policy Rust does not have, and Rust owns both the durable
 * value and the clock that enforces it (ADR-0012, ADR-0180). Adding a policy
 * starts in Rust; the type error here is the reminder to label it.
 *
 * Order is UX order (recommended first), not alphabetical.
 */
import type { UnloadPolicy } from './bindings.gen.js';

export const LOCAL_MODEL_UNLOAD_POLICY_OPTIONS: readonly {
	value: UnloadPolicy;
	label: string;
	description: string;
}[] = [
	{
		value: 'after_5_minutes',
		label: 'After 5 minutes',
		description: 'Drop the model after 5 minutes of inactivity. Good default.',
	},
	{
		value: 'after_30_minutes',
		label: 'After 30 minutes',
		description:
			'Drop the model after 30 minutes of inactivity. Useful for bursty workflows.',
	},
	{
		value: 'immediately',
		label: 'Immediately',
		description:
			'Drop after every transcription. Minimum memory, slowest next transcription.',
	},
	{
		value: 'never',
		label: 'Never',
		description: 'Keep the model resident until the app exits.',
	},
];
