<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { HOSTED_TRANSCRIPTION_MODEL } from '@epicenter/constants/ai-providers';
	import { getWhisperingApp } from '../whispering/context.js';
	const app = getWhisperingApp();
</script>

<InferencePicker
	scope="transcription"
	model={app.settings.get('transcriptionModel')}
	connections={app.inferenceConnections}
	accountModels={[{
		id: HOSTED_TRANSCRIPTION_MODEL,
		label: HOSTED_TRANSCRIPTION_MODEL,
		credits: 0,
	}]}
	includeRuntime
	onSelectModel={model => app.settings.set('transcriptionModel', model)}
/>
