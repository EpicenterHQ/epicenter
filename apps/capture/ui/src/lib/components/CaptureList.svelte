<!--
	The captures listed, newest first, under a heading for each day. Each one
	opens its own page; one still being written shows as such and opens
	nothing. When more captures match than are listed, reaching the end of
	the list asks for the next ones.
-->
<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Empty from '@epicenter/ui/empty';
	import * as Item from '@epicenter/ui/item';
	import { Skeleton } from '@epicenter/ui/skeleton';
	import { captures, idOf } from '$lib/captures.svelte.js';
	import { byDay, instantOf } from '$lib/days.js';

	const time = new Intl.DateTimeFormat(undefined, { timeStyle: 'short' });
	const days = $derived(byDay(captures.rows()));

	/** Asks for the next captures as `node` scrolls into view. */
	function showMoreWhenSeen(node: HTMLElement) {
		const observer = new IntersectionObserver(
			(entries) => {
				if (entries.some((entry) => entry.isIntersecting)) captures.showMore();
			},
			{ rootMargin: '400px' },
		);
		observer.observe(node);
		return () => observer.disconnect();
	}
</script>

{#if !captures.isLoaded()}
	<!-- Until the first answer; when it fails, the page says why above. -->
	<div
		class={['flex flex-col gap-3', captures.problem() && 'invisible']}
		aria-busy="true" aria-label="Loading captures">
		<Skeleton class="h-4 w-20" />
		{#each [0, 1, 2, 3] as index (index)}
			<Skeleton class="h-16 w-full" />
		{/each}
	</div>
{:else if days.length === 0}
	<Empty.Root class="border-0">
		<Empty.Header>
			{#if captures.matching()}
				<Empty.Title>Nothing matches “{captures.matching()}”</Empty.Title>
				<Empty.Description>The search looks through every capture's text and thoughts.</Empty.Description>
			{:else}
				<Empty.Title>Nothing captured yet</Empty.Title>
				<Empty.Description>Write something above. Each capture is a Markdown file in your Epicenter.</Empty.Description>
			{/if}
		</Empty.Header>
	</Empty.Root>
{:else}
	<div class="flex flex-col gap-6">
		{#each days as day (day.key)}
			<section aria-labelledby="day-{day.key}" class="flex flex-col gap-1">
				<h2
					id="day-{day.key}"
					class="sticky top-[env(safe-area-inset-top)] z-10 -mx-1 bg-background/90 px-1 py-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase backdrop-blur"
				>
					{day.label}
				</h2>
				<Item.Group class="gap-0 has-data-[size=sm]:gap-0">
					{#each day.rows as row (row.path)}
						{@const at = instantOf(row.capturedAt)}
						<Item.Root size="sm" class={['-mx-3 items-start', row.pending && 'opacity-60']}>
							{#snippet child({ props })}
								{#if row.pending}
									<div {...props} aria-busy="true">{@render content()}</div>
								{:else}
									<a href="#/c/{idOf(row.path)}" {...props}>{@render content()}</a>
								{/if}
							{/snippet}
						</Item.Root>
						{#snippet content()}
							<Item.Content class="min-w-0">
								<Item.Title class={['line-clamp-3 break-words whitespace-pre-line font-normal leading-relaxed', !row.text && 'text-muted-foreground']}>
									{row.text || 'Empty capture'}
								</Item.Title>
								<Item.Description class="text-xs">
									{#if row.pending}
										Saving…
									{:else if at}
										<time datetime={at.toISOString()}>{time.format(at)}</time>
									{/if}
									{#if row.thoughts > 0}
										· {row.thoughts} {row.thoughts === 1 ? 'thought' : 'thoughts'}
									{/if}
								</Item.Description>
							</Item.Content>
						{/snippet}
					{/each}
				</Item.Group>
			</section>
		{/each}

		{#if captures.more() > 0}
			{#key captures.rows().length}
				<div {@attach showMoreWhenSeen} class="flex justify-center">
					<Button variant="ghost" size="sm" onclick={() => captures.showMore()}>
						Show {Math.min(50, captures.more())} more
					</Button>
				</div>
			{/key}
		{/if}
	</div>
{/if}
