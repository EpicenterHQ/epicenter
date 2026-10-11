<!--
	The review for one `folder.sync` attempt (ADR-0514, ADR-0516): a row per
	conflict, grouped by file, with the two captured versions and the result.
	An edit session's `review` uses the same grid for a save that met a
	change made elsewhere, with its own labels, heading, and apply label.

	The review is modal: the page shows it in place of everything else while
	the attempt waits. It holds that attempt's choices and nothing else, only
	while it is shown. The parent keys it on `attempt.id`, so a new attempt
	starts with no choices. Cancel calls `onCancel`, which discards the
	attempt; nothing is remembered.

	`Use all from` takes one side for every part. `Use this` takes a captured
	version exactly. Typing writes a replacement:
	a body, a whole file, or a field or setting whose versions are all text is
	edited as text; any other value is edited as JSON and is not applied until
	it parses. `Leave out` removes a setting, a field, or a file that both sides still have. Apply calls
	`onApply(attempt, choices)` once per press, only when every conflict has a
	choice; the app calls `folder.sync.resolve` and passes back the problems an
	`InvalidChoices` refusal names, which show beside their rows until the
	person changes that row's choice.

	```svelte
	{#if attempt}
		{#key attempt.id}
			<SyncReview {attempt} {pending} {problems} {onCancel} {onApply} />
		{/key}
	{/if}
	```
-->
<script module lang="ts">
	import type { SyncConflict, SyncVersion } from '@epicenter/folder';

	/** Whether a conflict's result is edited as plain text rather than JSON. */
	export function editsText(conflict: SyncConflict): boolean {
		if (conflict.kind === 'body' || conflict.kind === 'file') return true;
		const present = [conflict.local, conflict.incoming].filter(
			(version) => version.present,
		);
		return (
			present.length > 0 &&
			present.every((version) => typeof version.value === 'string')
		);
	}

	/** How a value reads in a text area: its text, or its JSON. */
	export function display(conflict: SyncConflict, version: SyncVersion): string {
		if (!version.present) return '';
		if (version.value instanceof Uint8Array)
			return `Not text (${version.value.byteLength} bytes)`;
		return editsText(conflict) && typeof version.value === 'string'
			? version.value
			: JSON.stringify(version.value, null, 2);
	}

	/** The name a person reads for a conflict's part of its file. */
	export function partName(conflict: SyncConflict): string {
		switch (conflict.kind) {
			case 'setting':
				return conflict.key;
			case 'field':
				return conflict.field;
			case 'body':
				return 'Body';
			case 'file':
				return 'Whole file';
		}
	}
</script>

<script
	lang="ts"
	generics="TAttempt extends Pick<SyncAttempt, 'id' | 'conflicts'>"
>
	import type {
		SyncAttempt,
		SyncChoice,
		SyncChoiceProblem,
		SyncChoices,
		SyncSide,
	} from '@epicenter/folder';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';

	let {
		attempt,
		pending = false,
		problems = [],
		labels = { local: 'This device', incoming: 'Remote' },
		heading = 'Choose what to keep',
		description = 'These changes conflict with the remote. Nothing is saved until you apply.',
		applyLabel = 'Apply and sync',
		onCancel,
		onApply,
	}: {
		/** The captured attempt the choices answer. */
		attempt: TAttempt;
		/** A resolution is running: every control waits. */
		pending?: boolean;
		/** What the folder refused in the last Apply, shown beside each row. */
		problems?: readonly SyncChoiceProblem[];
		/** What a person calls each side. */
		labels?: { readonly local: string; readonly incoming: string };
		heading?: string;
		description?: string;
		applyLabel?: string;
		/** Discard the attempt and its choices. Without it there is no Cancel. */
		onCancel?: () => void;
		onApply: (attempt: TAttempt, choices: SyncChoices) => void;
	} = $props();

	// Replace-only: every edit assigns a new object, so a submitted object
	// never changes afterwards.
	let choices = $state.raw<SyncChoices>({});
	/**
	 * The choices the last Apply handed over. A refused choice's note shows
	 * only while that conflict still holds the same choice object.
	 */
	let submitted = $state.raw<SyncChoices>({});

	/** What the folder refused for this conflict's submitted choice, if it still stands. */
	function refusedFor(id: string): string[] {
		if (choices[id] === undefined || choices[id] !== submitted[id]) return [];
		return problems
			.filter((problem) => problem.conflictId === id)
			.map((problem) => problem.message);
	}

	/**
	 * JSON as a person typed it, by conflict ID, so the result shows their
	 * text rather than reformatted JSON. A choice exists only while it parses.
	 */
	let typedJson = $state.raw<Readonly<Record<string, string>>>({});

	const sides: readonly SyncSide[] = ['local', 'incoming'];
	const files = $derived.by(() => {
		const grouped = new Map<string, SyncConflict[]>();
		for (const conflict of attempt.conflicts)
			grouped.set(conflict.path, [...(grouped.get(conflict.path) ?? []), conflict]);
		return grouped;
	});
	const chosen = $derived(
		attempt.conflicts.filter(({ id }) => choices[id] !== undefined).length,
	);
	const complete = $derived(chosen === attempt.conflicts.length);

	function without<T>(record: Readonly<Record<string, T>>, key: string) {
		return Object.fromEntries(
			Object.entries(record).filter(([entry]) => entry !== key),
		) as Record<string, T>;
	}

	/** Take `side` for every part. */
	function chooseAll(side: SyncSide) {
		choices = Object.fromEntries(
			attempt.conflicts.map(({ id }) => [id, { kind: 'take', side }]),
		);
		typedJson = {};
	}
	function choose(id: string, choice: SyncChoice) {
		choices = { ...choices, [id]: choice };
		if (Object.hasOwn(typedJson, id)) typedJson = without(typedJson, id);
	}

	/** Typed text as a replacement; JSON counts once it parses. */
	function typed(conflict: SyncConflict, text: string) {
		if (editsText(conflict))
			return choose(conflict.id, { kind: 'replace', value: text });
		typedJson = { ...typedJson, [conflict.id]: text };
		try {
			choices = {
				...choices,
				[conflict.id]: { kind: 'replace', value: JSON.parse(text) },
			};
		} catch {
			choices = without(choices, conflict.id);
		}
	}

	/** Typed JSON that does not parse. */
	const unparsed = (id: string) =>
		Object.hasOwn(typedJson, id) && choices[id] === undefined;

	/** The result a row shows for its choice. */
	function result(conflict: SyncConflict): { text: string; removed: boolean } {
		if (Object.hasOwn(typedJson, conflict.id))
			return { text: typedJson[conflict.id] ?? '', removed: false };
		const choice = choices[conflict.id];
		switch (choice?.kind) {
			case undefined:
				return { text: '', removed: false };
			case 'remove':
				return { text: '', removed: true };
			case 'take': {
				const taken = conflict[choice.side];
				return { text: display(conflict, taken), removed: !taken.present };
			}
			case 'replace':
				return {
					text: display(conflict, { present: true, value: choice.value }),
					removed: false,
				};
		}
	}

	/** What the person needs to know about a row's result, if anything. */
	function note(conflict: SyncConflict): string | undefined {
		const refused = refusedFor(conflict.id);
		if (refused.length > 0) return refused.join(' ');
		if (unparsed(conflict.id))
			return 'Not a value yet. Write JSON, such as "text", 42, or true, or use a side.';
		if (result(conflict).removed)
			return conflict.kind === 'file' ? 'The file will be removed.' : `${partName(conflict)} will be left out.`;
		if (conflict.kind === 'file')
			return 'One version was deleted or is not valid. The text you choose is saved as it is.';
		return undefined;
	}

	const general = $derived(
		problems.filter((problem) => problem.conflictId === undefined),
	);
</script>

<form
	class="flex flex-col gap-4"
	aria-label="Review sync changes"
	onsubmit={(event) => {
		event.preventDefault();
		if (pending || !complete) return;
		submitted = choices;
		onApply(attempt, choices);
	}}
>
	<header>
		<h2 class="text-base font-medium">{heading}</h2>
		<p class="text-muted-foreground text-sm">{description}</p>
		{#if attempt.conflicts.length > 1}
			<div class="mt-2 flex flex-wrap gap-2">
				{#each sides as side (side)}
					<Button variant="outline" size="sm" disabled={pending} onclick={() => chooseAll(side)}>
						Use all from {labels[side]}
					</Button>
				{/each}
			</div>
		{/if}
	</header>

	{#each general as problem (problem.message)}
		<p class="text-destructive text-sm" role="alert">{problem.message}</p>
	{/each}

	{#each files as [path, conflicts] (path)}
		<section class="flex flex-col gap-3" aria-label={path}>
			<h3 class="font-mono text-sm">{path}</h3>
			{#each conflicts as conflict (conflict.id)}
				{@const name = partName(conflict)}
				{@const shown = result(conflict)}
				{@const hint = note(conflict)}
				{@const choice = choices[conflict.id]}
				<div
					class="grid gap-2 md:grid-cols-[8rem_repeat(3,minmax(0,1fr))]"
					role="group"
					aria-label={name}
				>
					<span class="font-mono text-xs break-all">{name}</span>
					{#each sides as side (side)}
						{@const version = conflict[side]}
						<div class="flex flex-col gap-1">
							<span class="text-muted-foreground text-xs">{labels[side]}</span>
							<Textarea
								readonly
								class="bg-muted max-h-64"
								value={display(conflict, version)}
								placeholder={version.present ? 'Empty' : conflict.kind === 'file' ? 'No file' : 'Not set'}
								aria-label="{name} on {labels[side]}"
							/>
							<Button
								variant="outline"
								size="sm"
								class="self-start"
								aria-pressed={choice?.kind === 'take' && choice.side === side}
								disabled={pending}
								onclick={() => choose(conflict.id, { kind: 'take', side })}
							>
								Use this
							</Button>
						</div>
					{/each}
					<div class="flex flex-col gap-1">
						<span class="text-muted-foreground text-xs">Result</span>
						<Textarea
							class="max-h-64"
							value={shown.text}
							placeholder={shown.removed ? 'Left out' : 'Choose a side or type'}
							aria-label="Result for {name}"
							aria-invalid={unparsed(conflict.id) ||
								refusedFor(conflict.id).length > 0 ||
								undefined}
							disabled={pending}
							oninput={(event) => typed(conflict, event.currentTarget.value)}
						/>
						{#if conflict.kind !== 'body' && conflict.local.present && conflict.incoming.present}
							<Button
								variant="ghost"
								size="sm"
								class="self-start"
								aria-pressed={choice?.kind === 'remove'}
								disabled={pending}
								onclick={() => choose(conflict.id, { kind: 'remove' })}
							>
								Leave out
							</Button>
						{/if}
						{#if hint !== undefined}
							<p class="text-muted-foreground text-xs">{hint}</p>
						{/if}
					</div>
				</div>
			{/each}
		</section>
	{/each}

	<footer class="flex flex-wrap items-center justify-between gap-2">
		<span class="text-muted-foreground text-sm" role="status">
			{#if pending}
				Applying…
			{:else}
				{chosen} of {attempt.conflicts.length} chosen
			{/if}
		</span>
		<div class="flex gap-2">
			{#if onCancel}
				<Button variant="outline" disabled={pending} onclick={onCancel}>Cancel</Button>
			{/if}
			<Button type="submit" disabled={pending || !complete}>{applyLabel}</Button>
		</div>
	</footer>
</form>
