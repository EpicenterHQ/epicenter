<!--
	Capture's front page: the box to capture into, then a search, then every
	capture newest first. It asks again every 15 seconds while visible and
	whenever the page comes back, so captures an agent adds appear.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as InputGroup from '@epicenter/ui/input-group';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { captures } from '$lib/captures.svelte.js';
	import CaptureList from '$lib/components/CaptureList.svelte';
	import Composer from '$lib/components/Composer.svelte';
	import { whileVisible } from '$lib/visible.js';

	$effect(() => whileVisible(() => void captures.refresh()));

	let search = $state(captures.matching());
	$effect(() => {
		const typed = search;
		const timer = setTimeout(() => captures.search(typed), 250);
		return () => clearTimeout(timer);
	});
</script>

<div class="flex flex-col gap-4">
	<h1 class="sr-only">Capture</h1>
	<Composer />

	<InputGroup.Root>
		<InputGroup.Addon><SearchIcon /></InputGroup.Addon>
		<InputGroup.Input
			type="search"
			bind:value={search}
			placeholder="Search captures"
			aria-label="Search captures"
			enterkeyhint="search"
			onkeydown={(event) => {
				if (event.key === 'Escape') search = '';
			}}
		/>
	</InputGroup.Root>

	{#if captures.problem()}
		<Alert.Root variant="destructive">
			<Alert.Title>Can't reach Epicenter</Alert.Title>
			<Alert.Description>
				<p>{captures.problem()}</p>
				<Button variant="outline" size="sm" class="mt-2" onclick={() => void captures.refresh()}>Try again</Button>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<CaptureList />
</div>
