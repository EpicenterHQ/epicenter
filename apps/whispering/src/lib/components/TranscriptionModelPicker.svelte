<script lang="ts">
	import { local } from '$lib/whispering/local.js';
	import { getInferenceTarget } from '$lib/whispering/inference.js';
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/constants/ai-providers';
	import { getWhisperingApp } from '../whispering/context.js';
	const app = getWhisperingApp();
</script>

<InferencePicker
	value={getInferenceTarget(local.kv, 'transcription')}
	catalog={app.catalog}
	accountModels={[
		{
			id: HOSTED_TRANSCRIPTION_MODEL,
			label: HOSTED_TRANSCRIPTION_MODEL,
			credits: 0,
		},
	]}
	includeRuntime
	onSelect={({ connectionId, model }) =>
		local.kv.update({
			transcriptionConnection: connectionId,
			transcriptionModel: model,
		})}
/>
