<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import * as Item from '@epicenter/ui/item';
	import TriangleAlertIcon from '@lucide/svelte/icons/triangle-alert';
	import { accessibilityGuide } from '$lib/components/MacosAccessibilityGuideDialog.svelte';
	import { outputWritesToCursor } from '$lib/operations/delivery';
	import { dictationCapability } from '$lib/state/dictation-capability.svelte';

	// A home banner that fires ONLY when something the user configured is broken,
	// never as a feature pitch. The dictation capability Rust owns already encodes
	// "is anything wrong": the Accessibility grant is needed only when paste at
	// cursor is configured (`untrusted`/`broken`, the states `needsAccessibility`
	// covers); with nothing to grant for, the capability settles to
	// `inactive`/`active` and this banner stays silent. Two registers, each a
	// real problem with a fix:
	//   - broken: a stale grant left paste at cursor unavailable. A
	//     previously-working paste path stopped firing, so it is a FAULT: amber
	//     glyph, `role="alert"`, and a primary action.
	//   - untrusted + paste at cursor configured: the paste the user asked for is
	//     silently falling back to the clipboard. A soft fault: amber glyph and a
	//     primary action, but no `role="alert"` (a steady recoverable state, not a
	//     change to announce).
	// All share one slim outlined `Item` (icon · message · trailing action) at the
	// same size, so backgrounds and padding stay uniform and only the glyph and the
	// action carry the register. None is dismissable: each clears itself when the
	// capability or the cursor toggle flips, and a quiet banner never needs hiding.
	// The detailed steps live in the guide dialog the action opens. The branch order
	// is load-bearing: `broken` is caught before the plain untrusted paste case.
	const cursorPasteNotFiring = $derived(
		dictationCapability.needsAccessibility &&
			!dictationCapability.isStale &&
			outputWritesToCursor(),
	);
</script>

{#if dictationCapability.isStale}
	<Item.Root variant="outline" size="sm" class="w-full" role="alert">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Paste at cursor isn't working</Item.Title>
			<Item.Description>
				Re-granting macOS Accessibility usually fixes it. Until then,
				transcripts go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{:else if cursorPasteNotFiring}
	<Item.Root variant="outline" size="sm" class="w-full">
		<Item.Media>
			<TriangleAlertIcon class="text-warning size-4" aria-hidden="true" />
		</Item.Media>
		<Item.Content>
			<Item.Title>Paste at cursor needs macOS Accessibility</Item.Title>
			<Item.Description>
				You've turned on paste at cursor, but it isn't granted yet. Until you
				grant it, transcripts go to your clipboard.
			</Item.Description>
		</Item.Content>
		<Item.Actions>
			<Button size="sm" onclick={() => accessibilityGuide.open()}>
				Show me how
			</Button>
		</Item.Actions>
	</Item.Root>
{/if}
