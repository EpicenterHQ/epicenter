<script lang="ts">
	import PersonalBoundary from '../PersonalBoundary.svelte';
	import PersonalPrompt from './PersonalPrompt.svelte';
	import { local } from '$lib/whispering/local.js';
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { Button } from '@epicenter/ui/button';
	import {
		DEVICE_DEFAULTS,
		PERSONAL_DEFAULTS,
	} from '$lib/operations/settings.js';
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { Textarea } from '@epicenter/ui/textarea';
	import {
		SUPPORTED_LANGUAGES_OPTIONS,
		type SupportedLanguage,
	} from '../../constants/languages.js';
	import { getTranscriptionReadiness } from '../../settings/transcription-validation.js';
	import { getWhisperingApp } from '../../whispering/context.js';
	import TranscriptionModelPicker from '../TranscriptionModelPicker.svelte';
	import AdvancedDisclosure from './AdvancedDisclosure.svelte';

	const whispering = getWhisperingApp();
	const openConnection = getConnectionScreen();
	const readiness = $derived(getTranscriptionReadiness(whispering));
</script>

<Field.Group>
	<Field.Field>
		<Field.Label>Transcription connection and model</Field.Label>
		<TranscriptionModelPicker />
		<Field.Description>
			Audio goes to this selection. Choose a model or enter its exact ID.
			Connections and keys stay on this device.
		</Field.Description>
		{#if readiness.primaryIssue}<p
				role="status"
				class="text-sm text-muted-foreground"
			>
				{readiness.primaryIssue}
			</p>{/if}
	</Field.Field>

	<AdvancedDisclosure>
		<Field.Group>
			<Field.Field>
				<Field.Label for="spoken-language">Spoken language</Field.Label>
				<Select.Root
					type="single"
					bind:value={
						() =>
							local.kv.get('transcriptionLanguage') ??
							DEVICE_DEFAULTS.transcriptionLanguage,
						(value) =>
							local.kv.update({
								transcriptionLanguage: value as SupportedLanguage,
							})
					}
				>
					<Select.Trigger id="spoken-language"
						>{SUPPORTED_LANGUAGES_OPTIONS.find(
							(option) =>
								option.value ===
								(local.kv.get('transcriptionLanguage') ??
									DEVICE_DEFAULTS.transcriptionLanguage),
						)?.label ?? 'Auto'}</Select.Trigger
					>
					<Select.Content>
						{#each SUPPORTED_LANGUAGES_OPTIONS as option}<Select.Item
								value={option.value}
								label={option.label}
							/>{/each}
					</Select.Content>
				</Select.Root>
				<Field.Description
					>Auto lets the model detect the language. A selected language is an
					advisory hint.</Field.Description
				>
			</Field.Field>
			<Field.Field>
				<Field.Label for="transcription-prompt"
					>Transcription prompt</Field.Label
				>
				<PersonalBoundary><PersonalPrompt /></PersonalBoundary>
				<Field.Description
					>Names and context can help models that support prompts. Dictionary
					terms are included.</Field.Description
				>
			</Field.Field>
		</Field.Group>
	</AdvancedDisclosure>
</Field.Group>
