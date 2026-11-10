<!--
	A rating from 1 to 5 as five stars. Tapping a star rates the book that
	many; tapping the rating it already has clears it. Without `onRate` it
	only shows the rating.
-->
<script lang="ts">
	import StarIcon from '@lucide/svelte/icons/star';

	let {
		rating,
		onRate,
		size = 'size-4',
	}: {
		rating: number | undefined;
		onRate?: (rating: number | null) => void;
		size?: string;
	} = $props();
</script>

{#if onRate}
	<div class="flex" role="group" aria-label="Rating">
		{#each [1, 2, 3, 4, 5] as star (star)}
			<button
				type="button"
				class="flex size-11 items-center justify-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
				aria-label="{star} of 5"
				aria-pressed={rating === star}
				onclick={() => onRate(rating === star ? null : star)}
			>
				<StarIcon
					class="{size} {rating !== undefined && star <= rating
						? 'fill-amber-400 text-amber-400'
						: 'text-muted-foreground/50'}"
				/>
			</button>
		{/each}
	</div>
{:else if rating !== undefined}
	<span class="inline-flex" aria-label="{rating} of 5">
		{#each [1, 2, 3, 4, 5] as star (star)}
			<StarIcon
				class="{size} {star <= rating ? 'fill-amber-400 text-amber-400' : 'text-muted-foreground/40'}"
			/>
		{/each}
	</span>
{/if}
