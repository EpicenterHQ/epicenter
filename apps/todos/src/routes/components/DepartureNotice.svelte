<script lang="ts">
	import type { Departure } from '@epicenter/epicenter/departure/page';

	let { departure }: { departure: Departure } = $props();

	const leaving = $derived(
		departure.notice?.intent === 'restart'
			? 'Epicenter is restarting for an account change'
			: 'Epicenter is quitting',
	);
	const ending = $derived(departure.notice?.intent === 'restart' ? 'restart' : 'quit');
</script>

<!-- What this page answers when Epicenter asks to quit or restart. Editing waits meanwhile. -->
{#if departure.notice !== undefined}
	<div
		class="flex flex-wrap items-center gap-2 border-b bg-warning/10 px-4 py-2 text-sm"
		role="status"
		aria-label="Leaving Epicenter"
	>
		{#if departure.notice.stage === 'saving'}
			<span>{leaving}. Finishing your saves first; editing waits until they are done.</span>
		{:else if departure.notice.stage === 'ready'}
			<span>{leaving}. This window is ready; editing waits until Epicenter leaves or the {ending} is cancelled.</span>
		{:else}
			<!-- Todos never asks: once its work settles nothing is lost, so it never shows a choice. -->
			<span>{leaving}.</span>
		{/if}
		{#if departure.problem !== undefined}
			<span role="status">Epicenter did not receive this window's answer: {departure.problem}</span>
		{/if}
	</div>
{/if}
