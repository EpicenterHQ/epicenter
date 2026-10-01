<script lang="ts">
	import { Link } from '@epicenter/ui/link';
	import KeyRoundIcon from '@lucide/svelte/icons/key-round';
	import SparklesIcon from '@lucide/svelte/icons/sparkles';
	import { resolve } from '$app/paths';
	import { polishStatus } from '$lib/state/polish.js';

	import { getWhisperingApp } from '$lib/whispering/context';

	const app = getWhisperingApp();
	const status = $derived(polishStatus(app));
	const triggerClass =
		'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-md px-2 text-sm no-underline hover:bg-accent hover:no-underline';
</script>

{#if status === 'needs-connection'}
	<Link
		href={resolve('/settings/processing')}
		tooltip="Cleanup needs setup; transcriptions currently use original text"
		class="{triggerClass} text-muted-foreground hover:text-foreground"
	>
		<KeyRoundIcon class="size-4 text-warning" />
		Raw output
	</Link>
{:else if status === 'on'}
	<Link
		href={resolve('/settings/dictation')}
		tooltip="Cleanup is on"
		class="{triggerClass} text-muted-foreground hover:text-foreground"
	>
		<SparklesIcon class="size-4 text-green-500" />
		Cleanup on
	</Link>
{:else}
	<Link
		href={resolve('/settings/dictation')}
		tooltip="Cleanup is off"
		class="{triggerClass} text-muted-foreground hover:text-foreground"
	>
		<SparklesIcon class="size-4" />
		Raw output
	</Link>
{/if}
