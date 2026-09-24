<!--
	One markdown token, rendered as real DOM and recursing into its children.
	Block tokens render their element and recurse `token.tokens` (or `items` /
	table cells); inline `text` leaves render their text. Because the tree is real elements (never an HTML string), there is
	no `{@html}` and no sanitize pass; the one place a value reaches an attribute
	(link href, image src) is scheme-checked below.

	Templates here are whitespace-tight on purpose: inter-token spacing already
	lives inside the text leaves (marked does not rely on markup whitespace), so
	any newline between sibling nodes would inject a spurious space, splitting CJK
	runs (你好 must not become 你 好).
-->
<script lang="ts">
	import type { Token } from 'marked';
	import MarkdownNode from './markdown-node.svelte';
	let { token }: { token: Token } = $props();

	// Schemes that execute when followed. The tree itself is inert DOM, so these
	// attribute values are the only injection surface (an assistant can echo a
	// link from prompt-injected tool output). `data:` is blocked for links (a
	// `data:text/html` page runs script) but allowed for image sources.
	const DANGEROUS_HREF = /^\s*(?:javascript|data|vbscript):/i;
	const DANGEROUS_SRC = /^\s*(?:javascript|vbscript):/i;
	const linkHref = (href: string) => (DANGEROUS_HREF.test(href) ? '#' : href);
	const imageSrc = (src: string) => (DANGEROUS_SRC.test(src) ? '' : src);
</script>

{#snippet children(tokens: Token[])}{#each tokens as child, i (i)}<MarkdownNode token={child} />{/each}{/snippet}

{#if token.type === 'paragraph'}
	<p>{@render children(token.tokens ?? [])}</p>
{:else if token.type === 'heading'}
	<svelte:element this={`h${token.depth}`}>{@render children(token.tokens ?? [])}</svelte:element>
{:else if token.type === 'blockquote'}
	<blockquote>{@render children(token.tokens ?? [])}</blockquote>
{:else if token.type === 'list'}
	{#if token.ordered}
		<ol start={typeof token.start === 'number' && token.start !== 1 ? token.start : undefined}>
			{#each token.items as item, i (i)}<li>{@render children(item.tokens)}</li>{/each}
		</ol>
	{:else}
		<ul>
			{#each token.items as item, i (i)}<li>{@render children(item.tokens)}</li>{/each}
		</ul>
	{/if}
{:else if token.type === 'checkbox'}
	<input type="checkbox" checked={token.checked} disabled />
{:else if token.type === 'code'}
	<pre><code class={token.lang ? `language-${token.lang}` : undefined}>{token.text}</code></pre>
{:else if token.type === 'table'}
	<table>
		<thead>
			<tr>
				{#each token.header as cell, i (i)}<th align={cell.align ?? undefined}>{@render children(cell.tokens)}</th>{/each}
			</tr>
		</thead>
		<tbody>
			{#each token.rows as row, r (r)}<tr>{#each row as cell, c (c)}<td align={cell.align ?? undefined}>{@render children(cell.tokens)}</td>{/each}</tr>{/each}
		</tbody>
	</table>
{:else if token.type === 'hr'}
	<hr />
{:else if token.type === 'strong'}
	<strong>{@render children(token.tokens ?? [])}</strong>
{:else if token.type === 'em'}
	<em>{@render children(token.tokens ?? [])}</em>
{:else if token.type === 'del'}
	<del>{@render children(token.tokens ?? [])}</del>
{:else if token.type === 'codespan'}
	<code>{token.text}</code>
{:else if token.type === 'br'}
	<br />
{:else if token.type === 'link'}
	<a href={linkHref(token.href)} title={token.title ?? undefined} target="_blank" rel="noopener noreferrer">{@render children(token.tokens ?? [])}</a>
{:else if token.type === 'image'}
	<img src={imageSrc(token.href)} alt={token.text} title={token.title ?? undefined} />
{:else if token.type === 'escape'}{token.text}
{:else if token.type === 'text'}
	{#if token.tokens}{@render children(token.tokens)}{:else}{token.text}{/if}
{:else if token.type === 'html' || token.type === 'tag'}
	<!-- Render raw HTML as visible text, never as live markup. -->
	{token.text}
{:else if token.type === 'space' || token.type === 'def'}
	<!-- No visible output. -->
{:else}
	<!-- Unknown token: fall back to its raw source so nothing is dropped. -->
	{'raw' in token ? token.raw : ''}
{/if}
