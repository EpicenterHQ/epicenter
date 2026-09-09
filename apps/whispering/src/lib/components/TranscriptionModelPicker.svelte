<script lang="ts">
	import { InferencePicker } from '@epicenter/app-shell/inference-picker';
	import * as Command from '@epicenter/ui/command';
	import { getWhisperingApp } from '../whispering/context.js';
	import { PROVIDERS } from '../services/transcription/providers.js';
	import { secrets } from '../state/secrets.svelte.js';
	const app = getWhisperingApp();
	const service = $derived(app.settings.get('transcriptionService'));
	const bespoke = $derived(service === 'Deepgram' || service === 'ElevenLabs' || service === 'Mistral' ? PROVIDERS[service] : null);
</script>

<InferencePicker
	scope="transcription"
	model={service === 'connection' ? app.settings.get('transcriptionModel') : ''}
	placeholder={bespoke ? `${bespoke.label} · ${app.settings.get(bespoke.modelSettingKey)}` : 'Select transcription model'}
	connections={app.inferenceConnections}
	accountModels={[{ id: 'whisper-1', label: 'whisper-1', credits: 0 }]}
	includeRuntime
	onSelectModel={model => {
		app.settings.set('transcriptionModel', model);
		app.settings.set('transcriptionService', 'connection');
	}}
>
	{#snippet additionalOptions(close)}
		<Command.Group heading="Other transcription providers">
			{#each ['Deepgram', 'ElevenLabs', 'Mistral'] as const as id}
				{@const provider = PROVIDERS[id]}
				{#if secrets.get(provider.apiKeyConfigKey).status === 'available'}
					<Command.Item value="provider {id}" onSelect={() => { app.settings.set('transcriptionService', id); close(); }}>
						{provider.label} · {app.settings.get(provider.modelSettingKey)}
					</Command.Item>
				{/if}
			{/each}
		</Command.Group>
	{/snippet}
</InferencePicker>
