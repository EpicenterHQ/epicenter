<!--
	What dictation still needs, at the top of Home: each says what is wrong
	and what still works, with one way to fix it. Nothing shows when all is set.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import CircleAlertIcon from '@lucide/svelte/icons/circle-alert';
	import { getDictation } from '#lib/dictation-view.ts';

	const dictation = getDictation();
</script>

{#each dictation.needs() as need (need.id)}
	<Alert.Root>
		<CircleAlertIcon />
		<Alert.Description>{need.problem}</Alert.Description>
		<!-- On its own line: a fix's label is longer than the room Alert.Action keeps beside the text. -->
		<div class="mt-2"><Button variant="outline" size="sm" href={need.fix.href}>{need.fix.label}</Button></div>
	</Alert.Root>
{/each}
