<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import { getWhisperingApp } from '../whispering/context.js';
	const app = getWhisperingApp();
</script>

<InferencePicker
	scope="transcription"
	model={app.settings.get('transcriptionModel')}
	connections={app.inferenceConnections}
	accountModels={[{ id: 'whisper-1', label: 'whisper-1', credits: 0 }]}
	includeRuntime
	onSelectModel={model => app.settings.set('transcriptionModel', model)}
/>
