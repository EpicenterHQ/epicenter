<!--
	The floating pill's own window (`pill.rs`): 240 by 40, transparent, over
	every app. Dictation runs in the main window, which sends what to show;
	presses go back to it. The window shows only while the pill does.
-->
<script lang="ts">
	import type { DictationView } from '#lib/dictation-view.ts';
	import { setDictation } from '#lib/dictation-view.ts';
	import { pill } from '#lib/platform/index.ts';
	import type { PillState } from '#lib/platform/pill/pill.ts';
	import Pill from '../Pill.svelte';

	let state = $state<PillState>({
		take: { kind: 'idle' },
		outcome: { kind: 'none' },
		level: 0,
		silent: false,
		handsFree: { kind: 'off' },
		keys: { toggle: '' },
		cleaning: false,
	});
	$effect(() => pill.onState((next) => (state = next)));

	const view: DictationView = {
		take: () => state.take,
		keys: () => state.keys,
		level: () => state.level,
		silent: () => state.silent,
		handsFree: () => state.handsFree,
		outcome: () => state.outcome,
		needs: () => [],
		isTranscribing: () => false,
		isCleaning: () => state.cleaning,
		toggle: () => pill.send({ kind: 'toggle' }),
		cancel: () => pill.send({ kind: 'cancel' }),
		dismiss: () => pill.send({ kind: 'dismiss' }),
		show: (id) => pill.send({ kind: 'show', id }),
		setHandsFree: (on) => pill.send({ kind: 'setHandsFree', on }),
		transcribe: () => {},
		forget: () => {},
	};
	setDictation(view);
</script>

<svelte:head>
	<title>Whispering pill</title>
	<!-- The window is transparent; only the pill is drawn. -->
	<style>
		html,
		body {
			background: transparent !important;
		}
	</style>
</svelte:head>

<main class="flex h-dvh items-center justify-center">
	<Pill onshownchange={(shown) => pill.setShown(shown)} />
</main>
