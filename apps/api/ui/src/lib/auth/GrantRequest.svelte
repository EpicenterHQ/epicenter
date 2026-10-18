<!--
	What an app is asking for, and which folders it may reach, on the consent
	page, which also approves device codes (ADR-0549). The folder choice is the
	grant's target: "All folders", "Personal", or one group.
-->
<script lang="ts">
	import { Label } from '@epicenter/ui/label';
	import * as RadioGroup from '@epicenter/ui/radio-group';
	import {
		describeScopes,
		type GrantTargetOption,
	} from './oauth-request';

	let {
		scopes,
		options,
		target = $bindable(''),
		disabled = false,
	}: {
		scopes: readonly string[];
		options: readonly GrantTargetOption[];
		target?: string;
		disabled?: boolean;
	} = $props();

	const lines = $derived(describeScopes(scopes));
</script>

{#if lines.length}
	<ul class="list-disc space-y-1 pl-5 text-sm">
		{#each lines as line (line)}<li>{line}</li>{/each}
	</ul>
{/if}
<fieldset class="flex flex-col gap-2" {disabled}>
	<legend class="mb-2 text-sm font-medium">Which folders can it reach?</legend>
	<RadioGroup.Root bind:value={target}>
		{#each options as option (option.target)}
			<div class="flex items-center gap-3">
				<RadioGroup.Item value={option.target} id={`target-${option.target}`} />
				<Label for={`target-${option.target}`}>{option.label}</Label>
			</div>
		{/each}
	</RadioGroup.Root>
</fieldset>
