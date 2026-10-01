<!--
	Render a markdown string as a Svelte component tree (no `{@html}`, no
	sanitize). Lex once with `marked`, then walk the tokens into real DOM via
	`<MarkdownNode>`. Text leaves render as text nodes.

	This runs once per settled message (streaming messages render raw text
	upstream), so a full re-lex on `content` change is intentional and cheap.
-->
<script lang="ts">
	import { marked } from 'marked';
	import { cn } from '../utils.js';
	import MarkdownNode from './markdown-node.svelte';

	let {
		content,
		class: className,
	}: {
		content: string;
		class?: string;
	} = $props();

	const tokens = $derived(marked.lexer(content, { gfm: true, breaks: true }));
</script>

<div class={cn('prose prose-sm', className)}>
	{#each tokens as token, i (i)}<MarkdownNode {token} />{/each}
</div>
