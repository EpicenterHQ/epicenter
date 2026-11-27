<!--
	What dictation still needs, said once on Home under the recorder: what is
	wrong and what still works, with the way to fix it. Nothing shows when
	all is set.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { getDictation } from '#lib/dictation-view.ts';

	const dictation = getDictation();
</script>

{#each dictation.needs() as need (need.id)}
	<p class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1 text-sm">
		<CircleAlertIcon class="size-4 shrink-0 text-destructive" />
		<span>{need.problem}</span>
		<Button variant="link" size="sm" class="h-auto p-0" href={need.fix.href}>{need.fix.label}</Button>
	</p>
{/each}
