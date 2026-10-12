<!--
	One prompt: what would be lost, and the person's choice. Mounted once per
	prompt; its choices carry the prompt's identity as it was issued, so a
	control of an earlier prompt never answers a later round. Writes and
	actions have finished by now, so only input never committed is named.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { onDestroy, untrack } from 'svelte';
	import type {
		Departure,
		DepartureNotice,
	} from '@epicenter/epicenter/departure/page';

	let {
		departure,
		prompt,
	}: {
		departure: Departure;
		prompt: Extract<DepartureNotice, { stage: 'choose' }>;
	} = $props();

	/** The prompt this instance was mounted for, fixed for its lifetime. */
	const issued = untrack(() => prompt);

	/** Whether this prompt is mounted; its buttons answer for a mounted prompt only. */
	const view = { mounted: true };
	onDestroy(() => {
		view.mounted = false;
	});

	const leaving =
		issued.intent === 'restart'
			? 'Epicenter is restarting for an account change'
			: 'Epicenter is quitting';
</script>

<span class="w-full">
	{leaving}, but the title of a new todo you have not added is still in the box.
	{issued.intent === 'restart' ? 'Restarting' : 'Quitting'} now loses it.
</span>
<Button size="xs" onclick={() => view.mounted && departure.keepWorking(issued.id)}>Keep working</Button>
<Button size="xs" variant="outline" onclick={() => view.mounted && departure.leaveAnyway(issued.id)}>
	{issued.intent === 'restart' ? 'Restart anyway' : 'Quit anyway'}
</Button>
