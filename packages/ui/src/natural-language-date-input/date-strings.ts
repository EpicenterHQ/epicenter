/**
 * The two branded date strings these inputs commit, declared locally.
 *
 * A brand is nominal by its literal tag, so this declaration and the store's
 * are the same type: a `CalendarDateString` produced by `@epicenter/app/field`
 * satisfies this one without a cast. That is what lets the component library
 * speak the store's date vocabulary without depending on the store, which the
 * UI boundary forbids and which these two type aliases would not justify.
 */

import type { Brand } from 'wellcrafted/brand';

/** Branded ISO calendar date string, `YYYY-MM-DD`: no time, offset, or zone. */
export type CalendarDateString = string & Brand<'CalendarDateString'>;

/** Branded RFC 3339 / ISO 8601 datetime string. */
export type DateTimeString = string & Brand<'DateTimeString'>;
