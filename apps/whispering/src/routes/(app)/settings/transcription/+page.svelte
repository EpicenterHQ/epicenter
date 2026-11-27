<!--
	Settings · Transcription. What turns a recording into text: a model on
	this computer, or a server. Both stay set up; the choice here says which
	one transcribes. A browser tab cannot run a model, so it shows the
	server alone.
-->
<script lang="ts">
	import * as Select from '@epicenter/ui/select';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import { local } from '#lib/platform/index.ts';
	import { queryClient, settingsMutations, settingsQueries } from '#lib/queries.ts';
	import SettingsRow from '../SettingsRow.svelte';
	import SettingsSection from '../SettingsSection.svelte';
	import LocalModels from './LocalModels.svelte';
	import ServerForm from './ServerForm.svelte';

	const settings = createQuery(() => settingsQueries.read());
	const provider = $derived(
		local.available ? (settings.data?.['transcription.provider'] ?? 'local') : 'server',
	);

	async function choose(value: string) {
		if (value !== 'local' && value !== 'server') return;
		const saved = await runMutation(queryClient, settingsMutations.update, {
			'transcription.provider': value,
		});
		toastOnError(saved, 'Could not save the choice');
	}
</script>

<svelte:head><title>Transcription · Whispering</title></svelte:head>

{#if local.available}
	<SettingsSection title="Transcription" description="What turns a recording into text.">
		<SettingsRow
			label="Transcribe with"
			description={provider === 'local'
				? 'Private, and works offline. A model is downloaded once.'
				: 'OpenAI, Groq, or a server of your own. Each recording is sent to it.'}
			for="provider"
		>
			<Select.Root type="single" value={provider} onValueChange={(value) => void choose(value)}>
				<Select.Trigger id="provider" class="w-44">
					{provider === 'local' ? 'This computer' : 'A server'}
				</Select.Trigger>
				<Select.Content>
					<Select.Item value="local">This computer</Select.Item>
					<Select.Item value="server">A server</Select.Item>
				</Select.Content>
			</Select.Root>
		</SettingsRow>
	</SettingsSection>
{/if}

{#if provider === 'local'}
	<LocalModels />
{:else}
	<ServerForm />
{/if}
