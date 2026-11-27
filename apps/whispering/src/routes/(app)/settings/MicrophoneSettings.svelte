<!--
	Which microphone to record from (`MicrophoneSelect`, which Home also
	shows). The chosen microphone's live level shows under the list, so a
	muted or silent one shows up here rather than in an empty transcript. The meter closes while a recording runs, which has
	its own.
-->
<script lang="ts">
	import * as Field from '@epicenter/ui/field';
	import { getDictation } from '#lib/dictation-view.ts';
	import { recorder } from '#lib/platform/index.ts';
	import { HEARD } from '#lib/platform/recorder/recorder.ts';
	import { createQuery } from '@tanstack/svelte-query';
	import { microphonesQueries, settingsQueries } from '#lib/queries.ts';
	import LevelMeter from '../../LevelMeter.svelte';
	import MicrophoneSelect from '../MicrophoneSelect.svelte';

	/** The same query the list reads, for why it could not ask. */
	const connected = createQuery(() => microphonesQueries.list());
	const listError = $derived(connected.error?.message);

	const dictation = getDictation();
	const settings = createQuery(() => settingsQueries.read());
	const microphone = $derived(settings.data?.microphone);

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
</script>

<Field.Set>
	<Field.Legend>Microphone</Field.Legend>
	<Field.Field>
		<Field.Label for="microphone">Record from</Field.Label>
		<MicrophoneSelect id="microphone" />
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
