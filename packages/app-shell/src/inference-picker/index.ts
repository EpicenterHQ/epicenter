export type { InferenceTarget } from '../inference-selections.js';
export { connectionLabel } from './connection-label.js';
export {
	createInferenceConnections,
	type HostedModel,
	type InferenceConnections,
} from './connections.svelte.js';
export { default as CrossDeviceModelGap } from './cross-device-model-gap.svelte';
export { default as InferencePicker } from './inference-picker.svelte';
