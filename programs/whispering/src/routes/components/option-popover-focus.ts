/**
 * Where focus goes when one of the recorder's option popovers closes.
 *
 * A popover's own default is to return focus to whatever was focused before
 * it opened. These three replace one another, so that element can be another
 * option's trigger: open the microphone popover, switch to the model, press
 * Escape, and focus would land on the microphone's trigger. And a popover
 * that was replaced must not take focus back from the one that replaced it.
 *
 * So the default is always refused, and the popover's own trigger is focused
 * only when focus is still this popover's to give back: inside its content,
 * or nowhere. Focus that has already moved elsewhere is left where it is.
 */
export function returnFocusToTrigger(
	event: Event,
	trigger: HTMLElement | null,
	content: HTMLElement | null,
) {
	event.preventDefault();
	const focused = document.activeElement;
	if (
		focused === null ||
		focused === document.body ||
		content?.contains(focused)
	)
		trigger?.focus({ preventScroll: true });
}
