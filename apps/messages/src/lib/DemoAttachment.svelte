<script lang="ts">
	import * as Dialog from '@epicenter/ui/dialog';
	import { Link } from '@epicenter/ui/link';
	import type { DemoAttachment } from './demo/attachments.js';
	let { attachment }: { attachment: DemoAttachment } = $props();
	let imageFailed = $state(false);
</script>

{#if attachment.kind === 'image'}
	{#if imageFailed}
		<p role="status" class="text-sm">The demo photo could not load.</p>
	{:else}
		<Dialog.Root>
			<Dialog.Trigger>
				{#snippet child({ props })}
					<button {...props} class="block w-72 max-w-full overflow-hidden rounded-md text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" aria-label="View photo: {attachment.title}">
						<img src={attachment.source} alt={attachment.description} class="aspect-[4/3] w-full object-cover" width="1448" height="1086" onerror={() => { imageFailed = true; }} />
						<span class="block py-1 text-xs">View photo · fictional demo</span>
					</button>
				{/snippet}
			</Dialog.Trigger>
			<Dialog.Content class="sm:max-w-3xl">
				<Dialog.Header>
					<Dialog.Title>{attachment.title}</Dialog.Title>
					<Dialog.Description>{attachment.description}</Dialog.Description>
				</Dialog.Header>
				<img src={attachment.source} alt={attachment.description} class="max-h-[65vh] w-full rounded-md object-contain" width="1448" height="1086" />
			</Dialog.Content>
		</Dialog.Root>
	{/if}
{:else}
	<div class="space-y-1 rounded-md border p-3">
		<p class="text-sm font-medium">{attachment.title}</p>
		<p class="text-xs text-muted-foreground">{attachment.description}</p>
		<Link href={attachment.source} download={attachment.filename} class="text-sm">Download sample file</Link>
	</div>
{/if}
