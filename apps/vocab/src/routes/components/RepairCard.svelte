<!--
	A word file that is not a valid word, open as its exact text. Each change
	is saved as typed, and the issues are read live from what is typed. Once
	the text is a valid word, "Show note and stage" opens it as a word again.
-->
<script lang="ts">
	import { parseRow } from '@epicenter/folder';
	import type { TextSession } from '@epicenter/svelte/edit-session';
	import { Button } from '@epicenter/ui/button';
	import { Textarea } from '@epicenter/ui/textarea';
	import { vocabFolder } from '$lib/data.js';
	import type { EntriesState } from '$lib/entries.svelte.js';
	import SaveBar from '@epicenter/svelte/save-bar';
	import { openWord } from './word-actions.js';

	let { entries, id, session }: { entries: EntriesState; id: string; session: TextSession } = $props();

	/** Why the text is not a word yet, read live from what is typed. */
	const issues = $derived(parseRow(vocabFolder.tables.entries, session.draft).error ?? undefined);
</script>

<section class="space-y-2 rounded-lg border border-destructive/50 p-4 text-xs" aria-label="Repair {session.path}">
	<p>
		<code>{session.path}</code> is not a valid word, so its note and stage cannot be shown. Edit its text here; each
		change is saved as typed.
	</p>
	<Textarea
		class="min-h-32 font-mono text-xs"
		aria-label="File text for {session.path}"
		readonly={session.locked}
		bind:value={() => session.draft, (text) => session.input(text)}
	/>
	{#if issues}
		<ul role="alert" class="space-y-1 text-destructive">
			{#each issues as issue, index (index)}
				<li>{issue.line === undefined ? '' : `Line ${issue.line}: `}{issue.message}</li>
			{/each}
		</ul>
	{:else}
		<Button size="sm" variant="outline" disabled={session.locked} onclick={() => void openWord(entries, id)}>Show note and stage</Button>
	{/if}
	<SaveBar
		save={session.state}
		review={session.review}
		hideWhenSaved
		onRetry={() => session.retry()}
		onKeepMine={() => entries.keepMine(session)}
		onReloadTheirs={() => entries.reloadTheirs(session)}
	/>
</section>
