<!--
	Capture's front page: the box to capture into, then a search, then every
	capture newest first. The layout's client asks again whenever Capture's
	files change, so captures an agent adds appear.
-->
<script lang="ts">
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import * as InputGroup from '@epicenter/ui/input-group';
	import SearchIcon from '@lucide/svelte/icons/search';
	import { createQuery, useMutationState } from '@tanstack/svelte-query';
	import { type Row, reads, writes } from '$lib/app.js';
	import CaptureList from '$lib/components/CaptureList.svelte';
	import Composer from '$lib/components/Composer.svelte';

	const PAGE = 50;

	let search = $state('');
	/** The search sent: what was typed, trimmed, once typing pauses. */
	let matching = $state('');
	let limit = $state(PAGE);
	$effect(() => {
		const typed = search.trim();
		const timer = setTimeout(() => {
			if (typed === matching) return;
			matching = typed;
			limit = PAGE;
		}, 250);
		return () => clearTimeout(timer);
	});

	const recent = createQuery(() => ({
		...reads.recent({ limit, ...(matching ? { matching } : {}) }),
		// Until a new search answers, the last answer shows, narrowed here by its text.
		placeholderData: (previous, previousQuery) => {
			if (!previous) return undefined;
			const [{ matching: before = '' } = {}] = (previousQuery?.queryKey.at(-1) ?? []) as [{ matching?: string }?];
			if (before === matching) return previous;
			const needle = matching.toLowerCase();
			return { captures: previous.captures.filter((row) => row.text.toLowerCase().includes(needle)), total: 0 };
		},
	}));

	/** Captures whose `add` has not answered, newest first, listed while they are written. */
	const adding = useMutationState({
		filters: { mutationKey: writes.add.mutationKey, status: 'pending' },
		select: (mutation): Row => ({
			path: `pending-${mutation.mutationId}`,
			capturedAt: new Date(mutation.state.submittedAt).toISOString(),
			text: (mutation.state.variables as { text: string }).text.trim(),
			thoughts: 0,
			pending: true,
		}),
	});
	const rows = $derived([...adding.toReversed(), ...(recent.data?.captures ?? [])]);
	const more = $derived(Math.max(0, (recent.data?.total ?? 0) - (recent.data?.captures.length ?? 0)));
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

	{#if recent.isError}
		<Alert.Root variant="destructive">
			<Alert.Title>Can't reach Epicenter</Alert.Title>
			<Alert.Description>
				<p>{recent.error.message}</p>
				<Button variant="outline" size="sm" class="mt-2" onclick={() => recent.refetch()}>Try again</Button>
			</Alert.Description>
		</Alert.Root>
	{/if}

	<CaptureList
		{rows}
		{more}
		{matching}
		loading={recent.isPending}
		failed={recent.isError}
		showMore={() => (limit += PAGE)}
	/>
</div>
