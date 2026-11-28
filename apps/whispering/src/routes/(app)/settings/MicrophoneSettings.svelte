<!--
	Which microphone to record from (`MicrophoneSelect`, which Home also
	shows). The chosen microphone's live level shows under the list, so a
	muted or silent one shows up here rather than in an empty transcript. The meter closes while a recording runs, which has
	its own.
-->
<script lang="ts">
	import { getDictation } from '#lib/dictation-view.ts';
	import { recorder } from '#lib/platform/index.ts';
	import { HEARD } from '#lib/platform/recorder/recorder.ts';
	import { createQuery } from '@tanstack/svelte-query';
	import { microphonesQueries, settingsQueries } from '#lib/queries.ts';
	import LevelMeter from '../../LevelMeter.svelte';
	import MicrophoneSelect from '../MicrophoneSelect.svelte';
	import SettingsRow from './SettingsRow.svelte';
	import SettingsSection from './SettingsSection.svelte';

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

<SettingsSection title="Microphone" description="A choice is used from the next recording on.">
	<SettingsRow label="Record from" for="microphone" error={listError}>
		<div class="w-64 max-w-full"><MicrophoneSelect id="microphone" /></div>
	</SettingsRow>
	<SettingsRow
		label="Level"
		description={dictation.take().kind !== 'idle'
			? 'Recording now; the level shows on Home and the pill.'
			: heard
				? 'This microphone hears you.'
				: 'Say something: the bars should move.'}
		error={meterError}
	>
		{#if dictation.take().kind === 'idle' && !meterError}
			<LevelMeter {level} class="w-24 text-primary" />
		{/if}
	</SettingsRow>
</SettingsSection>
