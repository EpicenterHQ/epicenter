<script lang="ts">
	import { agentMessageText } from '@epicenter/agent';
	import {
		AgentChatThread,
		type ConversationHandle,
	} from '@epicenter/app-shell/agent-chat';
	import { getConnectionScreen } from '@epicenter/app-shell/boot-screens';
	import { complete } from '@epicenter/client';
	import { Button } from '@epicenter/ui/button';
	import CheckIcon from '@lucide/svelte/icons/check';
	import { untrack } from 'svelte';
	import {
		buildEntryCandidatePrompt,
		parseEntryCandidates,
	} from '$lib/entry-candidates';
	import { getAuth } from '$lib/auth.svelte.js';
	import { getVocabSurface } from '$lib/surface';
	import DictationButton from './DictationButton.svelte';
	import ReadingMarkdown from './ReadingMarkdown.svelte';

	const auth = getAuth();
	const accountManagementUrl = auth.accountManagementUrl;
	const { entries } = getVocabSurface();
	const openConnection = getConnectionScreen();
	// The route keys this whole surface on Account identity, like its inference client.
	const account = untrack(() => {
		const state = auth.state;
		return state.status === 'signed-out' ? undefined : state.account;
	});

	let {
		active,
		showReadings,
	}: { active: ConversationHandle | undefined; showReadings: boolean } = $props();

	// `active` does not narrow inside a snippet closure (a snippet can outlive the
	// `{#if active}` guard), so the input accessory reads these instead of the
	// handle directly.
	const isGenerating = $derived(active?.isLoading ?? false);

	let saveAffordance = $state.raw<{
		text: string;
		x: number;
		y: number;
	} | null>(
		null,
	);

	/** The selection's text with ruby annotations stripped: `toString()` would
	 * include the reading `<rt>`/`<rp>` nodes, so selecting a word with readings
	 * shown would capture the reading too instead of the verbatim characters. */
	function selectedEntryText(selection: Selection): string {
		const fragment = selection.getRangeAt(0).cloneContents();
		for (const annotation of fragment.querySelectorAll('rt, rp')) {
			annotation.remove();
		}
		return fragment.textContent?.trim() ?? '';
	}

	function handleSelectionChange() {
		const selection = document.getSelection();
		if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
			saveAffordance = null;
			return;
		}

		const text = selectedEntryText(selection);
		if (!text) {
			saveAffordance = null;
			return;
		}

		const anchorElement =
			selection.anchorNode instanceof Element
				? selection.anchorNode
				: selection.anchorNode?.parentElement;
		const focusElement =
			selection.focusNode instanceof Element
				? selection.focusNode
				: selection.focusNode?.parentElement;
		// Same container required, not just any two: a drag from one message
		// across the gap into another would otherwise save the whole span.
		const anchorSource = anchorElement?.closest('[data-entry-source]');
		const focusSource = focusElement?.closest('[data-entry-source]');
		if (!anchorSource || anchorSource !== focusSource) {
			saveAffordance = null;
			return;
		}

		const rect = selection.getRangeAt(0).getBoundingClientRect();
		saveAffordance = { text, x: rect.left + rect.width / 2, y: rect.top };
	}

	function saveSelectedEntry() {
		if (!saveAffordance) return;
		entries.save(saveAffordance.text);
		document.getSelection()?.removeAllRanges();
		saveAffordance = null;
	}

	/** Cap entry candidates so a long answer cannot build a runaway tray. */
	const ENTRY_CANDIDATE_CAP = 20;

	/** The transient entry candidates for one settled message, held in component
	 * memory only. Nothing here is persisted; a chosen span reaches the pool solely
	 * through `entries.save` (ADR-0102). One open at a time, like the selection
	 * affordance above. */
	let entryCandidateRequest = $state.raw<{
		messageId: string;
		status: 'loading' | 'ready' | 'error';
		candidates: string[];
		/** The completion error's own message, shown only in the `error` state so a
		 * failing local endpoint (401, refused, 500) says why. */
		detail?: string;
	} | null>(null);

	/** Aborts the in-flight entry candidate request when the user cancels or starts
	 * another one. */
	let entryCandidateAbortController: AbortController | null = null;

	/** Ask the model for the notable spans in one settled message and open the
	 * tray with them. It is a one-shot completion (`complete`), so it writes no
	 * transcript turn and stores no gloss or provenance: the response lives only in
	 * `entryCandidateRequest.candidates` until the user saves or dismisses it. */
	async function suggestEntries(messageId: string, passage: string) {
		// Abort any prior request still in flight so it stops consuming the endpoint;
		// its result is dropped by the stale-message guard below regardless.
		entryCandidateAbortController?.abort();
		const model = active?.model;
		if (!model) {
			entryCandidateAbortController = null;
			entryCandidateRequest = {
				messageId,
				status: 'error',
				candidates: [],
				detail: 'No model selected.',
			};
			return;
		}
		const controller = new AbortController();
		entryCandidateAbortController = controller;
		entryCandidateRequest = { messageId, status: 'loading', candidates: [] };
		const connection = inferenceConnections.resolveOrHosted(model);
		const { data, error } = await complete(connection, {
			model,
			systemPrompt: buildEntryCandidatePrompt(),
			userPrompt: passage,
			signal: controller.signal,
		});
		// A dismiss, a cancel, or a request for another message may have superseded
		// this one while it was in flight; drop the stale result rather than
		// overwrite. (A cancel nulls the request, so an aborted request lands here.)
		if (entryCandidateRequest?.messageId !== messageId) return;
		if (error) {
			entryCandidateRequest = {
				messageId,
				status: 'error',
				candidates: [],
				detail: error.message,
			};
			return;
		}
		entryCandidateRequest = {
			messageId,
			status: 'ready',
			candidates: parseEntryCandidates(data).slice(0, ENTRY_CANDIDATE_CAP),
		};
	}

	/** Close the entry candidate tray, aborting the request first when one is still loading. */
	function dismissEntryCandidates() {
		entryCandidateAbortController?.abort();
		entryCandidateAbortController = null;
		entryCandidateRequest = null;
	}

	/** Whether a candidate is already in the pool, derived from entries so it is
	 * never stored on the candidate and reflects a save immediately. */
	function isEntrySaved(text: string): boolean {
		return entries.entries.some((entry) => entry.text === text);
	}

	/** Land a dictated transcript in the draft for review, appended to whatever is
	 * already typed. Guarded so it is a no-op if the conversation went away. */
	function appendTranscript(text: string) {
		if (!active) return;
		const draft = active.inputValue.trim();
		active.inputValue = draft ? `${draft} ${text}` : text;
	}
	const { inferenceConnections } = getVocabSurface();
</script>

<svelte:document onselectionchange={handleSelectionChange} />

{#if saveAffordance}
	<button
		type="button"
		class="fixed z-50 -translate-x-1/2 -translate-y-full rounded border bg-popover px-2 py-1 text-xs shadow-sm"
		style="left: {saveAffordance.x}px; top: {saveAffordance.y - 6}px;"
		onpointerdown={(event) => event.preventDefault()}
		onclick={saveSelectedEntry}
	>
		Save entry
	</button>
{/if}

{#if active}
	<AgentChatThread
		conversation={active}
		connections={inferenceConnections}
		placeholder="Ask about a word, phrase, or sentence you're learning..."
		onSignIn={openConnection}
		onUpgrade={accountManagementUrl ? () => {
			if (!account) return;
			window.open(
				accountManagementUrl(account).href,
				'_blank',
				'noopener',
			);
		} : undefined}
	>
		{#snippet inputAccessory()}
			<DictationButton disabled={isGenerating} onTranscript={appendTranscript} />
		{/snippet}
		{#snippet message(msg, streaming)}
			{#if msg.role === 'user' || streaming}
				<!-- Raw text while the answer streams (and for the user's own turn): the
				rich markdown + readings pass runs once the message settles. -->
				<div class="whitespace-pre-wrap">{agentMessageText(msg)}</div>
			{:else}
				<div data-entry-source>
					<ReadingMarkdown passage={agentMessageText(msg)} {showReadings} />
				</div>

				{#if entryCandidateRequest?.messageId === msg.id}
					<div class="mt-2 rounded-md border bg-muted/40 p-2">
						{#if entryCandidateRequest.status === 'loading'}
							<div class="flex items-center justify-between gap-2">
								<p class="text-xs text-muted-foreground">Finding suggestions...</p>
								<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
									Cancel
								</Button>
							</div>
						{:else if entryCandidateRequest.status === 'error'}
							<div class="flex items-center justify-between gap-2">
								<div class="min-w-0">
									<p class="text-xs text-muted-foreground">
										Couldn't read entries from this message.
									</p>
									{#if entryCandidateRequest.detail}
										<p
											class="mt-0.5 truncate text-xs text-muted-foreground/70"
											title={entryCandidateRequest.detail}
										>
											{entryCandidateRequest.detail}
										</p>
									{/if}
								</div>
								<div class="flex shrink-0 gap-1">
									<Button
										variant="ghost"
										size="sm"
										onclick={() => suggestEntries(msg.id, agentMessageText(msg))}
									>
										Try again
									</Button>
									<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
										Dismiss
									</Button>
								</div>
							</div>
						{:else if entryCandidateRequest.candidates.length === 0}
							<div class="flex items-center justify-between gap-2">
								<p class="text-xs text-muted-foreground">No entries found here.</p>
								<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
									Dismiss
								</Button>
							</div>
						{:else}
							<div class="mb-1.5 flex items-center justify-between">
								<span class="text-xs text-muted-foreground">
									Tap an entry to save it
								</span>
								<Button variant="ghost" size="sm" onclick={dismissEntryCandidates}>
									Dismiss
								</Button>
							</div>
							<div class="flex flex-wrap gap-1.5">
								{#each entryCandidateRequest.candidates as candidate (candidate)}
									{@const saved = isEntrySaved(candidate)}
									<button
										type="button"
										class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-sm {saved
											? 'text-muted-foreground'
											: 'hover:bg-accent'}"
										disabled={saved}
										onclick={() => entries.save(candidate)}
									>
										{#if saved}<CheckIcon class="size-3" />{/if}
										{candidate}
									</button>
								{/each}
							</div>
						{/if}
					</div>
				{:else}
					<button
						type="button"
						class="mt-1.5 text-xs text-muted-foreground hover:text-foreground"
						onclick={() => suggestEntries(msg.id, agentMessageText(msg))}
					>
						Suggest entries
					</button>
				{/if}
			{/if}
		{/snippet}
		{#snippet emptyState()}
			<div
				class="flex flex-1 items-center justify-center text-muted-foreground"
			>
				<p>
					Ask a question and get an answer in the language you're learning, plus
					English.
				</p>
			</div>
		{/snippet}
	</AgentChatThread>
{/if}
