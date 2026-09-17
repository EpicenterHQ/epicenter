/**
 * `@epicenter/data/field`: the closed field-type vocabulary.
 *
 * Two halves over ONE wire-form:
 * - `field.*` builders (authoring) construct a schema in the recognized form.
 * - `recognize` (recognition) classifies a stored schema back to its kind.
 *
 * They are inverses: `recognize` of a serialized `field.X(...)` is kind `X`.
 * `json` (the open escape kind) and {@link jsonValue} (its any-JSON inner) live here;
 * emptiness (`nullable`) does NOT, it is substrate policy each consumer layers on at
 * its own edge.
 */

export { field, jsonValue } from './builders.js';
export { CalendarDateString } from './calendar-date-string.js';
export { DateTimeString } from './datetime-string.js';
export {
	compile,
	type Field,
	type FieldOf,
	type Kind,
	REFERENCE_KEYWORD,
	recognize,
	referenceTargetOf,
} from './field.js';
export { InstantString } from './instant-string.js';
