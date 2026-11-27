<!--
	Which microphone to record from. A choice is saved the moment it is made
	and used from the next recording on. The chosen microphone's live level
	shows under the list, so a muted or silent one shows up here rather than
	in an empty transcript. The meter closes while a recording runs, which has
	its own.
-->
<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import * as Select from '@epicenter/ui/select';
	import { toastOnError } from '@epicenter/ui/toast-on-error';
	import { getDictation } from '#lib/dictation-view.ts';
	import { recorder } from '#lib/platform/index.ts';
	import { HEARD, type Input } from '#lib/platform/recorder/recorder.ts';
	import { createQuery } from '@tanstack/svelte-query';
	import { runMutation } from 'wellcrafted/query';
	import {
		microphonesQueries,
		queryClient,
		settingsMutations,
		settingsQueries,
	} from '#lib/queries.ts';
	import LevelMeter from '../../LevelMeter.svelte';

	/** The value the list gives the system default; a microphone's own id never looks like it. */
	const DEFAULT = '';

	/** The microphones connected now: asked when the page opens and each time the list does. */
	const connected = createQuery(() => microphonesQueries.list());
	const inputs = $derived<Input[]>(connected.data ?? []);
	const listError = $derived(connected.error?.message);

	const dictation = getDictation();
	const settings = createQuery(() => settingsQueries.read());
	const microphone = $derived(settings.data?.microphone);
	const chosen = $derived(microphone ?? DEFAULT);
	const systemDefault = $derived(inputs.find((input) => input.isDefault));
	const label = $derived(
		chosen === DEFAULT
			? `System default${systemDefault ? ` (${systemDefault.name})` : ''}`
			: (inputs.find((input) => input.id === chosen)?.name ?? 'A microphone that is not connected'),
	);

	let level = $state(0);
	let heard = $state(false);
	let meterError = $state<string>();

	// Listen to the chosen microphone while the page is open and nothing records.
	$effect(() => {
		if (dictation.take().kind !== 'idle') return;
		const device = microphone ?? null;
		level = 0;
		heard = false;
		meterError = undefined;
		let close: (() => void) | undefined;
		let gone = false;
		void recorder
			.listen(device, (next) => {
				level = next;
				if (next > HEARD) heard = true;
			})
			.then(({ data, error }) => {
				if (gone) return data?.();
				if (error) meterError = error.message;
				else close = data;
			});
		return () => {
			gone = true;
			close?.();
		};
	});

	async function choose(value: string) {
		const saved = await runMutation(queryClient, settingsMutations.update, {
			microphone: value === DEFAULT ? undefined : value,
		});
		toastOnError(saved, 'Could not save the microphone');
	}
</script>

<Field.Set>
	<Field.Legend>Microphone</Field.Legend>
	<Field.Field>
		<Field.Label for="microphone">Record from</Field.Label>
		<Select.Root
			type="single"
			value={chosen}
			onValueChange={(value) => void choose(value)}
			onOpenChange={(open) => {
				if (open) void connected.refetch();
			}}
		>
			<Select.Trigger id="microphone" class="w-full">{label}</Select.Trigger>
			<Select.Content>
				<Select.Item value={DEFAULT}>
					System default{systemDefault ? ` (${systemDefault.name})` : ''}
				</Select.Item>
				{#each inputs as input (input.id)}
					<Select.Item value={input.id}>{input.name}</Select.Item>
				{/each}
			</Select.Content>
		</Select.Root>
		{#if listError}
			<Field.Error>{listError}</Field.Error>
		{:else if dictation.take().kind !== 'idle'}
			<Field.Description>Recording now; the level shows in the bar above.</Field.Description>
		{:else if meterError}
			<Field.Error>{meterError}</Field.Error>
		{:else}
			<LevelMeter {level} class="text-primary" />
			<Field.Description>
				{heard ? 'This microphone hears you.' : 'Say something: the bar should move.'}
			</Field.Description>
		{/if}
	</Field.Field>
</Field.Set>
