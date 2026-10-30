<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { Kbd } from '@epicenter/ui/kbd';
	import { Spinner } from '@epicenter/ui/spinner';
	import { Textarea } from '@epicenter/ui/textarea';
	import Mic from '@lucide/svelte/icons/mic';
	import Square from '@lucide/svelte/icons/square';
	import type { VoiceQueue } from '../queue.svelte.js';

	let { queue }: { queue: VoiceQueue } = $props();
	const pending = $derived(
		queue.flow === 'sending' || queue.flow === 'transcribing' || queue.flow === 'checking',
	);
</script>

<footer class="shrink-0 space-y-2 border-t bg-background p-4 pb-[max(1rem,env(safe-area-inset-bottom))] md:space-y-3 md:px-6">
	{#if queue.voiceOff}
		<p class="line-clamp-2 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">Voice is off: {queue.voiceOff}</p>
	{/if}
	{#if queue.targetId && queue.targetId !== queue.selectedId}
		<p class="line-clamp-2 break-words text-sm text-muted-foreground [overflow-wrap:anywhere]">
			This message is for {queue.threads.get(queue.targetId)?.title ?? 'the conversation where recording started'}.
		</p>
	{/if}
	{#if queue.flow === 'sendFailed' || queue.flow === 'sendUnknown' || queue.flow === 'checking' || (queue.voiceOff && queue.flow === 'idle')}
		<Textarea
			aria-label="Message"
			placeholder="Type a message for Codex"
			bind:value={queue.recognizedText}
			disabled={pending}
			readonly={queue.draft?.uncertain && queue.flow !== 'sendUnknown'}
			maxlength={20000}
			rows={3}
			class="max-h-32"
		/>
	{:else if queue.flow === 'sending'}
		<p class="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground">
			{queue.recognizedText}
		</p>
	{/if}
	{#if queue.flow === 'sendUnknown' || queue.flow === 'checking'}
		<p class="text-sm">Codex may already have this reply. The gateway could not confirm delivery.</p>
	{/if}
	<div class="flex flex-wrap items-center gap-2">
		{#if queue.flow === 'transcribeFailed'}
			<Button class="flex-1 md:flex-none" onclick={() => queue.retryTranscription()}>Retry transcription</Button>
			<Button variant="outline" onclick={() => queue.discard()}>Discard</Button>
		{:else if queue.flow === 'sendUnknown'}
			<Button disabled={!queue.draft} onclick={() => queue.checkConversation()}>Check conversation</Button>
			<Button disabled={!queue.recognizedText.trim()} onclick={() => queue.sendAsNew()}>Send as new message</Button>
			<Button variant="outline" onclick={() => queue.discard()}>Discard</Button>
		{:else if queue.flow === 'sendFailed'}
			<Button
				class="flex-1 md:flex-none"
				disabled={(queue.isBusy && !queue.draft?.uncertain) || !queue.recognizedText.trim()}
				onclick={() => queue.send()}
			>
				Retry send
			</Button>
			<Button variant="outline" onclick={() => queue.discard()}>Discard</Button>
		{:else if pending}
			<Button class="flex-1 md:flex-none" size="lg" disabled>
				<Spinner />
				{queue.flow === 'checking' ? 'Checking conversation' : queue.flow === 'transcribing' ? 'Transcribing' : 'Sending'}
			</Button>
		{:else if queue.voiceOff}
			<Button
				class="flex-1 md:flex-none"
				size="lg"
				disabled={!queue.selectedId || queue.isBusy || !queue.recognizedText.trim()}
				onclick={() => queue.sendText()}
			>
				Send
			</Button>
		{:else}
			<Button
				class="flex-1 md:flex-none"
				size="lg"
				disabled={!queue.selectedId || (queue.isBusy && queue.flow !== 'recording') || (queue.flow === 'recording' && !queue.recorder.isRecording)}
				onclick={() => queue.toggleRecord()}
			>
				{#if queue.flow === 'recording'}
					<Square />
					Stop and send
				{:else}
					<Mic />
					Record
				{/if}
			</Button>
		{/if}
		<Button
			variant="outline"
			onclick={() => queue.next()}
			disabled={!queue.selectedId || queue.flow !== 'idle'}
		>
			Skip
		</Button>
		{#if queue.flow === 'recording'}
			<Button variant="ghost" onclick={() => queue.discard()}>
				Cancel <span class="hidden md:inline"><Kbd>Esc</Kbd></span>
			</Button>
		{/if}
		<span class="ml-auto hidden text-xs text-muted-foreground md:inline">
			<Kbd>Space</Kbd> record / stop · <Kbd>j</Kbd> next · <Kbd>k</Kbd> previous
		</span>
	</div>
	<p class="line-clamp-2 min-h-5 text-sm text-muted-foreground" aria-live="polite">
		{queue.recorder.error ?? (queue.isBusy && queue.flow === 'idle' ? 'Codex is working on this conversation' : queue.status)}
	</p>
</footer>
