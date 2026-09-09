<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Field from '@epicenter/ui/field';
	import { Input } from '@epicenter/ui/input';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import { SUPPORTED_LANGUAGES_OPTIONS, type SupportedLanguage } from '../../constants/languages.js';
	import { PROVIDERS } from '../../services/transcription/providers.js';
	import { getTranscriptionReadiness } from '../../settings/transcription-validation.js';
	import { deviceConfig } from '../../state/device-config.svelte.js';
	import { secrets } from '../../state/secrets.svelte.js';
	import { getWhisperingApp } from '../../whispering/context.js';
	import TranscriptionModelPicker from '../TranscriptionModelPicker.svelte';
	import AdvancedDisclosure from './AdvancedDisclosure.svelte';
	import ProviderConfigFields from './ProviderConfigFields.svelte';

	const app = getWhisperingApp();
	const service = $derived(app.settings.get('transcriptionService'));
	const readiness = $derived(getTranscriptionReadiness(app));
	const previous = $derived.by(() => {
		if (service === 'speaches') {
			const endpoint = deviceConfig.get('providers.speaches.endpoint').trim();
			const model = deviceConfig.get('providers.speaches.modelId').trim();
			return endpoint && model ? { name: 'Speaches', baseUrl: `${endpoint.replace(/\/+$/, '')}/v1`, model } : null;
		}
		if (service !== 'OpenAI' && service !== 'Groq') return null;
		const provider = PROVIDERS[service];
		const key = secrets.get(provider.apiKeyConfigKey);
		const override = deviceConfig.get(provider.endpointConfigKey).trim();
		const model = app.settings.get(provider.modelSettingKey).trim();
		if (!model || (!override && key.status !== 'available')) return null;
		return {
			name: provider.label,
			baseUrl: override || (service === 'OpenAI' ? 'https://api.openai.com/v1' : 'https://api.groq.com/openai/v1'),
			apiKey: key.status === 'available' ? key.value : undefined,
			model,
		};
	});
</script>

<Field.Group>
	<Field.Field>
		<Field.Label>Transcription connection and model</Field.Label>
		<TranscriptionModelPicker />
		<Field.Description>
			Audio goes to this selection. Choose a model or enter its exact ID. Connections and keys stay on this device.
		</Field.Description>
		{#if readiness.primaryIssue}<p role="status" class="text-sm text-muted-foreground">{readiness.primaryIssue}</p>{/if}
		{#if previous}
			{@const saved = previous}
			<Button variant="outline" onclick={() => {
				const { model, ...connection } = saved;
				const id = app.inferenceConnections.add(connection, [model]);
				app.inferenceConnections.select('transcription', { connectionId: id, model: saved.model });
				app.settings.set('transcriptionModel', saved.model);
				app.settings.set('transcriptionService', 'connection');
			}}>Use saved {saved.name} endpoint: {saved.model}</Button>
		{/if}
	</Field.Field>

	<AdvancedDisclosure label="Other transcription providers">
		<Field.Group>
			{#each ['Deepgram', 'ElevenLabs', 'Mistral'] as const as id}
				{@const provider = PROVIDERS[id]}
				<Field.Field>
					<Field.Label>{provider.label}</Field.Label>
					<ProviderConfigFields provider={id} />
					<Field.Label for="transcription-model-{id}">Model ID</Field.Label>
					<Input id="transcription-model-{id}" value={app.settings.get(provider.modelSettingKey)} onblur={event => app.settings.set(provider.modelSettingKey, event.currentTarget.value)} />
					<Button variant={service === id ? 'secondary' : 'outline'} disabled={secrets.get(provider.apiKeyConfigKey).status !== 'available'} onclick={() => app.settings.set('transcriptionService', id)}>
						{service === id ? `Using ${provider.label}` : `Use ${provider.label}`}
					</Button>
				</Field.Field>
			{/each}
		</Field.Group>
	</AdvancedDisclosure>

	<AdvancedDisclosure>
		<Field.Group>
			<Field.Field>
				<Field.Label for="spoken-language">Spoken language</Field.Label>
				<Select.Root type="single" bind:value={() => app.settings.get('transcriptionLanguage'), value => app.settings.set('transcriptionLanguage', value as SupportedLanguage)}>
					<Select.Trigger id="spoken-language">{SUPPORTED_LANGUAGES_OPTIONS.find(option => option.value === app.settings.get('transcriptionLanguage'))?.label ?? 'Auto'}</Select.Trigger>
					<Select.Content>
						{#each SUPPORTED_LANGUAGES_OPTIONS as option}<Select.Item value={option.value} label={option.label} />{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description>Auto lets the model detect the language. A selected language is an advisory hint.</Field.Description>
			</Field.Field>
			<Field.Field>
				<Field.Label for="transcription-prompt">Transcription prompt</Field.Label>
				<Textarea id="transcription-prompt" value={app.settings.get('transcriptionPrompt')} onblur={event => app.settings.set('transcriptionPrompt', event.currentTarget.value)} />
				<Field.Description>Names and context can help models that support prompts. Dictionary terms are included. Use Recipes for rewriting or translation.</Field.Description>
			</Field.Field>
		</Field.Group>
	</AdvancedDisclosure>
</Field.Group>
