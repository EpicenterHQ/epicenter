export type {
	InferenceTarget,
	ResolvedInferenceTarget,
} from '../target.js';
export {
	createInferenceCatalog,
	type HostedModel,
	type InferenceCatalog,
} from './catalog.svelte.js';
export { connectionLabel } from './connection-label.js';
export { default as CrossDeviceModelGap } from './cross-device-model-gap.svelte';
export { default as InferencePicker } from './inference-picker.svelte';
