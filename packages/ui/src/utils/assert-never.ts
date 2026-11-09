/**
 * The end of an exhaustive `switch` or `if` chain over a union: at compile
 * time it only accepts `never`, so a case added to the union and not handled
 * is a type error here; at run time a value that got through anyway (data
 * from outside the type system) throws instead of falling through silently.
 *
 * ```ts
 * switch (error.name) {
 * 	case 'Missing': return …;
 * 	default: return assertNever(error);
 * }
 * ```
 */
export function assertNever(value: never): never {
	throw new Error(`Unhandled case: ${JSON.stringify(value) ?? String(value)}`);
}
