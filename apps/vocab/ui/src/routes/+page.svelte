<!--
	Review: the words due now, one at a time. A graded word leaves the queue at
	once and comes back if its review is not saved; a word graded `again`
	returns at the end of this sitting.
-->
<script lang="ts">
	import type { ActionError } from '@epicenter/app/client';
	import { resolve } from '$app/paths';
	import * as Alert from '@epicenter/ui/alert';
	import { Button } from '@epicenter/ui/button';
	import { IconButton } from '@epicenter/ui/icon-button';
	import * as Empty from '@epicenter/ui/empty';
	import { Loading } from '@epicenter/ui/loading';
	import { toast } from '@epicenter/ui/sonner';
	import PencilIcon from '@lucide/svelte/icons/pencil';
	import { createMutation, createQuery, useMutationState } from '@tanstack/svelte-query';
	import type { Grade } from '../../../epicenter.js';
	import { type DueWord, hrefOf, reads, writes } from '$lib/app.js';
	import { langOf, untilLabel } from '$lib/text.js';
	import WordFace from '$lib/WordFace.svelte';

	const LABELS = {
		again: 'Again',
		hard: 'Hard',
		good: 'Good',
		easy: 'Easy',
	} satisfies Record<Grade, string>;
	const GRADES = Object.keys(LABELS) as Grade[];

	const VARIANTS = {
		again: 'destructive',
		hard: 'secondary',
		good: 'default',
		easy: 'secondary',
	} as const satisfies Record<Grade, string>;

	const due = createQuery(() => reads.due());
	const words = createQuery(() => reads.list());
	const review = createMutation(() => writes.review);

	/** The words whose reviews are on their way, which leave the queue at once. */
	const grading = useMutationState({
		filters: { mutationKey: writes.review.mutationKey, status: 'pending' },
		select: (mutation) => (mutation.state.variables as { path: string }).path,
	});
	/** Words graded `again` this sitting, with their new schedule, last in the queue until they are due. */
	let again = $state.raw<DueWord[]>([]);
	const queue = $derived.by(() => {
		const server = due.data ?? [];
		const queued = [...server, ...again.filter((word) => !server.some((other) => other.path === word.path))];
		return queued.filter((word) => !grading.includes(word.path));
	});
	const word = $derived(queue[0]);
	/** The word whose answer is showing; another word starts hidden. */
	let revealed = $state<string>();
	const isRevealed = $derived(word !== undefined && revealed === word.path);

	/** When the next word is due, once nothing is. */
	const nextDue = $derived(
		(words.data ?? [])
			.map((row) => row.due)
			.filter((due) => due !== undefined)
			.sort()[0],
	);

	function grade(grade: Grade) {
		if (!word) return;
		const graded = word;
		const others = () => again.filter((other) => other.path !== graded.path);
		// Each review settles its own promise, so quick grades of several words each land.
		review.mutateAsync({ path: graded.path, grade }).then(
			({ due: when, interval, ease, reps, next }) => {
				again = grade === 'again' ? [...others(), { ...graded, due: when, interval, ease, reps, next }] : others();
			},
			(error: ActionError) =>
				toast.error(`Your review of ${graded.word} was not saved`, { description: error.message }),
		);
	}

	function onkeydown(event: KeyboardEvent) {
		if (!word || event.metaKey || event.ctrlKey || event.altKey) return;
		if (event.target instanceof HTMLElement && event.target.closest('input, textarea, [role="dialog"]')) return;
		if (!isRevealed && (event.key === ' ' || event.key === 'Enter')) {
			event.preventDefault();
			revealed = word.path;
			return;
		}
		const chosen = isRevealed ? GRADES[Number(event.key) - 1] : undefined;
		if (chosen) {
			event.preventDefault();
			grade(chosen);
		}
	}
</script>

<svelte:window {onkeydown} />

{#if due.isPending}
	<Loading class="flex-1" />
{:else if due.isError}
	<div class="mx-auto w-full max-w-2xl p-4">
		<Alert.Root variant="destructive">
			<Alert.Title>Vocab could not reach your Epicenter</Alert.Title>
			<Alert.Description>{due.error.message}</Alert.Description>
		</Alert.Root>
		<Button class="mt-3" variant="outline" onclick={() => due.refetch()}>Try again</Button>
	</div>
{:else if !word}
	<Empty.Root class="flex-1">
		<Empty.Header>
			<Empty.Title>{words.data?.length === 0 ? 'No words yet' : 'All caught up'}</Empty.Title>
			<Empty.Description>
				{#if words.data?.length === 0}
					Add a word, or ask your agent to add some while you chat.
				{:else if nextDue}
					{words.data?.length} words saved. The next is due in {untilLabel(nextDue, new Date())}.
				{/if}
			</Empty.Description>
		</Empty.Header>
		<Empty.Content>
			<Button href={resolve('/add')}>Add a word</Button>
		</Empty.Content>
	</Empty.Root>
{:else}
	{@const text = word.word}
	<div class="mx-auto flex w-full max-w-2xl flex-1 flex-col px-4 pt-4 pb-4">
		<div class="flex items-center justify-between text-sm text-muted-foreground">
			<p aria-live="polite"><span class="tabular-nums">{queue.length}</span> due</p>
			<IconButton
				label="Edit {text}"
				size="sm"
				variant="ghost"
				href={hrefOf(word.path)}
			>
				<PencilIcon />
			</IconButton>
		</div>

		{#if isRevealed}
			<div class="flex flex-1 flex-col items-center justify-center gap-6 py-8 text-center">
				<p lang={langOf(text)} class="text-6xl font-medium break-words md:text-7xl">{text}</p>
				<WordFace {word} />
			</div>
		{:else}
			<button
				type="button"
				class="flex flex-1 flex-col items-center justify-center gap-6 rounded-xl py-8 text-center outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
				onclick={() => (revealed = word.path)}
			>
				<span lang={langOf(text)} class="text-6xl font-medium break-words md:text-7xl">{text}</span>
				<span class="text-sm text-muted-foreground">Tap to show</span>
			</button>
		{/if}

		{#if isRevealed}
			<div class="grid grid-cols-4 gap-2" role="group" aria-label="How well did you remember it?">
				{#each GRADES as option, index (option)}
					<Button
						variant={VARIANTS[option]}
						class="h-16 flex-col gap-0.5 text-base"
						aria-label="{LABELS[option]}, due again in {untilLabel(word.next[option], new Date())}"
						aria-keyshortcuts={String(index + 1)}
						onclick={() => grade(option)}
					>
						{LABELS[option]}
						<span class="text-xs font-normal opacity-70" aria-hidden="true"
							>{untilLabel(word.next[option], new Date())}</span
						>
					</Button>
				{/each}
			</div>
		{:else}
			<Button class="h-16 text-base" aria-keyshortcuts="Space" onclick={() => (revealed = word.path)}>
				Show answer
			</Button>
		{/if}
	</div>
{/if}
