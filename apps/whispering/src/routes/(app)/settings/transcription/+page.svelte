<!--
	Settings · Transcription. What turns a recording into text: a model on
	this computer, or a server. Both stay set up; the choice here says which
	one transcribes. A browser tab cannot run a model, so it shows the
	server alone.
-->
<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import { local } from '#lib/platform/index.ts';
	import { queryClient, settingsMutations, settingsQueries } from '#lib/queries.ts';
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

{#if local.available}
	<Field.Set>
		<Field.Legend>Transcribe with</Field.Legend>
		<RadioGroup.Root value={provider} onValueChange={(value) => void choose(value)}>
			<Field.Field orientation="horizontal">
				<RadioGroup.Item value="local" id="with-local" />
				<Field.Content>
					<Field.Label for="with-local">This computer</Field.Label>
					<Field.Description>
						Private, and works offline. A model is downloaded once.
					</Field.Description>
				</Field.Content>
			</Field.Field>
			<Field.Field orientation="horizontal">
				<RadioGroup.Item value="server" id="with-server" />
				<Field.Content>
					<Field.Label for="with-server">A server</Field.Label>
					<Field.Description>
						OpenAI, Groq, or one of your own. Each recording is sent to it.
					</Field.Description>
				</Field.Content>
			</Field.Field>
		</RadioGroup.Root>
	</Field.Set>
{/if}

{#if provider === 'local'}
	<LocalModels />
{:else}
	<ServerForm />
{/if}
