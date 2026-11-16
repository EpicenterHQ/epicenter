<script lang="ts">
	import { AlertDialog as AlertDialogPrimitive } from "bits-ui";
	import {
		buttonVariants,
		type ButtonVariant,
	} from "$lib/components/ui/button";
	import { cn } from "$lib/utils";

	let {
		ref = $bindable(null),
		class: className,
		variant = "outline",
		...restProps
	}: AlertDialogPrimitive.CancelProps & {
		variant?: ButtonVariant;
	} = $props();
</script>

<AlertDialogPrimitive.Cancel
	bind:ref
	data-slot="alert-dialog-cancel"
	class={cn(buttonVariants({ variant }), "", className)}
	{...restProps}
/>
