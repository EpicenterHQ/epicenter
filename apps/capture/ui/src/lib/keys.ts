/**
 * Whether this device has no touch screen as its main pointer, which stands in for a
 * keyboard: Enter submits there, and the first field takes focus. On a
 * touch screen, Return makes a new line and focusing would open the keyboard.
 */
export function hasKeyboard(): boolean {
	return !matchMedia('(pointer: coarse)').matches;
}
