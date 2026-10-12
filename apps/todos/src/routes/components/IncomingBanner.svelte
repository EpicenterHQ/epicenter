<script lang="ts">
	import { Button } from '@epicenter/ui/button';
	import { toast } from '@epicenter/ui/sonner';
	import { Spinner } from '@epicenter/ui/spinner';
	import { createMutation } from '@tanstack/svelte-query';
	import { Err, Ok } from 'wellcrafted/result';
	import { incomingLine, recoveryLine, type StatusLine } from '$lib/status.js';
	import { todos } from '$lib/todos.svelte.js';


	const recovery = createMutation(() => todos.recoverIncoming.options);

	/** The incoming update that has not finished, as the folder last read it. */
	const pending = $derived(incomingLine(todos.git));
	/**
	 * The last recovery request's answer, kept beside the report while the
	 * update stays pending, so a refusal's paths and reason stay readable.
	 */
	const last = $derived(
		recovery.isSuccess
			? recoveryLine(Ok(recovery.data))
			: recovery.isError
				? recoveryLine(Err(recovery.error))
				: undefined,
	);

	const notify: Record<StatusLine['tone'], typeof toast.info> = {
		good: toast.success,
		neutral: toast.info,
		busy: toast.info,
		warning: toast.warning,
		error: toast.error,
	};

	function recover() {
		recovery.mutate(undefined, {
			onSettled: (outcome, error) => {
				const line = recoveryLine(error ? Err(error) : Ok(outcome!));
				notify[line.tone](line.label, { description: line.detail });
			},
		});
	}
</script>

<!--
	Shown while an incoming update is pending. It is only reported here;
	nothing resumes it until the person asks.
-->
{#if pending}
	<section
		class="border-b bg-destructive/5 px-3 py-2 text-xs sm:px-4"
		aria-label="Incoming update"
		data-testid="incoming-pending"
	>
		<div class="flex flex-wrap items-center gap-2">
			<span class="font-medium" role="status">{pending.label}</span>
			<Button
				size="xs"
				disabled={recovery.isPending || todos.departing}
				tooltip="Finish or clear the update from the files as they are now. If a file holds neither version, it is named and nothing is written."
				data-testid="recover-incoming"
				onclick={recover}
			>
				{#if recovery.isPending}<Spinner class="size-3" />{/if}
				Recover incoming update
			</Button>
		</div>
		{#if pending.detail}
			<p class="mt-1 text-muted-foreground">{pending.detail}</p>
		{/if}
		{#if last && last.tone !== 'good'}
			<div class="mt-1.5" data-testid="recovery-result">
				<p class="font-medium">{last.label}</p>
				{#if last.detail}
					<p class="break-words whitespace-pre-line text-muted-foreground">{last.detail}</p>
				{/if}
			</div>
		{/if}
	</section>
{/if}
