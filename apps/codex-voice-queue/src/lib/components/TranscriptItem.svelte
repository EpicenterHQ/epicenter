<script lang="ts">
	import { Badge } from '@epicenter/ui/badge';
	import { Markdown } from '@epicenter/ui/markdown';
	import type { KnownThreadItem, ThreadItem } from '../protocol.js';
	import { parseQuestionReply } from '../transcript.js';
	let { item }: { item: ThreadItem } = $props();
	const tags = new Set([
		'userMessage',
		'agentMessage',
		'reasoning',
		'commandExecution',
		'fileChange',
		'plan',
		'mcpToolCall',
		'dynamicToolCall',
		'webSearch',
		'contextCompaction',
		'enteredReviewMode',
		'exitedReviewMode',
		'imageView',
		'sleep',
		'imageGeneration',
		'hookPrompt',
		'functionCallOutput',
		'collabAgentToolCall',
		'subAgentActivity',
	]);
	// Known tags use the local projection; future tags retain a visible fallback.
	const known = $derived(tags.has(item.type) ? item as KnownThreadItem : null);
</script>

<div class="min-w-0 max-w-full space-y-2 break-words py-3 text-sm [overflow-wrap:anywhere] [&_[data-slot=badge]]:max-w-full [&_[data-slot=badge]]:whitespace-normal [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto [&_img]:max-w-full">
	{#if !known}
		<p class="text-muted-foreground">Unsupported item: {item.type}</p>
	{:else if known.type === 'userMessage'}
		<p class="text-xs font-medium text-muted-foreground">You</p>
		{#each known.content as input, index (index)}
			{#if input.type === 'text'}
				{@const replies = parseQuestionReply(input.text)}
				{#if replies}
					{#each replies as reply, index (index)}
						<p class="whitespace-pre-wrap break-words text-xs text-muted-foreground">{reply.question}</p>
						<p class="whitespace-pre-wrap break-words">{reply.answer}</p>
					{/each}
				{:else}
					<p class="whitespace-pre-wrap break-words">{input.text}</p>
				{/if}
			{:else if input.type === 'skill' || input.type === 'mention'}
				<Badge variant="outline">{input.type}: {input.name}</Badge>
			{:else if input.type === 'localImage' || input.type === 'localAudio'}
				<Badge variant="outline">{input.type}: {input.path}</Badge>
			{:else}
				<Badge variant="outline">{input.type}</Badge>
			{/if}
		{/each}
	{:else if known.type === 'agentMessage'}
		<div class="flex items-center gap-2 text-xs text-muted-foreground">
			Codex
		</div>
		<Markdown content={known.text} class={known.phase === 'commentary' ? 'text-xs text-muted-foreground' : ''} />
	{:else if known.type === 'reasoning'}
		<details>
			<summary class="cursor-pointer text-muted-foreground">Reasoning</summary>
			<div class="whitespace-pre-wrap pt-2">{(known.summary.length ? known.summary : known.content).join('\n\n')}</div>
		</details>
	{:else if known.type === 'commandExecution'}
		<div class="flex flex-wrap items-center gap-2">
			<code class="break-words [overflow-wrap:anywhere]">{known.command}</code>
			{#if known.status !== 'completed' || (known.exitCode !== null && known.exitCode !== 0)}
				<Badge variant="outline">
					{known.status}{known.exitCode !== null && known.exitCode !== 0 ? ` · exit ${known.exitCode}` : ''}
				</Badge>
			{/if}
		</div>
		{#if known.aggregatedOutput}
			<details>
				<summary class="cursor-pointer text-muted-foreground">Command output</summary>
				<p class="break-words [overflow-wrap:anywhere] font-mono text-xs text-muted-foreground">{known.cwd}</p>
				<pre class="max-h-96 max-w-full overflow-auto overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] pt-2 text-xs">{known.aggregatedOutput.slice(0, 20000)}</pre>
				{#if known.aggregatedOutput.length > 20000}
					<p class="text-muted-foreground">Output truncated to 20000 characters.</p>
				{/if}
			</details>
		{/if}
	{:else if known.type === 'fileChange'}
		<p class="text-xs text-muted-foreground">Edited {known.changes.length} {known.changes.length === 1 ? 'file' : 'files'}{known.status !== 'completed' ? ` · ${known.status}` : ''}</p>
		{#each known.changes as change, index (index)}
			<details>
				<summary class="cursor-pointer break-words [overflow-wrap:anywhere] font-mono text-xs">{change.kind.type} {change.path}</summary>
				<pre class="max-h-96 max-w-full overflow-auto overflow-x-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] pt-2 text-xs">{change.diff}</pre>
			</details>
		{/each}
	{:else if known.type === 'plan'}
		<Markdown content={known.text} />
	{:else if known.type === 'mcpToolCall'}
		<p class="text-muted-foreground">Tool {known.server}/{known.tool}{known.status !== 'completed' ? ` · ${known.status}` : ''}</p>
	{:else if known.type === 'dynamicToolCall'}
		<p class="text-muted-foreground">Tool {known.namespace ? `${known.namespace}/` : ''}{known.tool}{known.status !== 'completed' ? ` · ${known.status}` : ''}</p>
	{:else if known.type === 'webSearch'}
		<p class="text-muted-foreground">Web search: {known.query}</p>
	{:else if known.type === 'contextCompaction'}
		<p class="text-muted-foreground">Conversation context compacted</p>
	{:else if known.type === 'enteredReviewMode'}
		<p class="text-muted-foreground">Entered review: {known.review}</p>
	{:else if known.type === 'exitedReviewMode'}
		<p class="text-muted-foreground">Review finished: {known.review}</p>
	{:else if known.type === 'imageView'}
		<p class="break-words [overflow-wrap:anywhere] text-muted-foreground">Viewed image: {known.path}</p>
	{:else if known.type === 'sleep'}
		<p class="text-muted-foreground">Codex waited</p>
	{:else if known.type === 'imageGeneration'}
		<p class="text-muted-foreground">Image generation</p>
	{:else if known.type === 'hookPrompt'}
		<p class="text-muted-foreground">Hook prompt · {known.fragments.length} fragments</p>
	{:else if known.type === 'functionCallOutput'}
		<p class="text-muted-foreground">Function output: {known.name}</p>
	{:else if known.type === 'collabAgentToolCall'}
		<p class="text-muted-foreground">Agent tool: {known.tool}{known.status !== 'completed' ? ` · ${known.status}` : ''}</p>
	{:else if known.type === 'subAgentActivity'}
		<p class="text-muted-foreground">Agent activity: {known.kind} · {known.agentPath}</p>
	{:else}
		<p class="text-muted-foreground">Unsupported item: {item.type}</p>
	{/if}
</div>
