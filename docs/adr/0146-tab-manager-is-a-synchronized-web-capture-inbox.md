# 0146. Tab Manager is a synchronized web-capture inbox

- **Status:** Accepted
- **Date:** 2026-07-14
- **Relates:** [ADR-0051](0051-one-agent-loop-its-store-seam-chooses-persistence.md) (the prior Tab Manager conversation surface is not part of the new first version)

## Context

The current Tab Manager combines browser-owned live tabs with synchronized
devices, saved tabs, permanent bookmarks, tool trust, and conversations. The
device model exists to support installation presence that the platform no
longer exposes. Saved tabs and bookmarks overlap, while the product's distinct
value is much smaller: capture something from the browser into synchronized
data, then process it later.

## Decision

Tab Manager is rebuilt as a synchronized web-capture inbox. The browser remains
the authority for live tabs, windows, groups, and browser actions. Epicenter
owns one versioned SQLite table:

```ts
type WebCapture = {
	id: WebCaptureId;
	url: string;
	title: string;
	favIconUrl: string | null;
	capturedAt: InstantString;
};
```

The first product has three durable verbs: capture, open, and discard. Opening
a capture creates a browser tab and consumes the inbox row only when the user
chooses that action. There is no devices table, source node, generic presence,
per-device prompt, bookmarks table, tool-trust table, or conversation table in
this version.

A future promotion action belongs to its destination. For example, `Create
Honeycrisp note` first creates the destination object and deletes the capture
only after success. Epicenter does not create a generic cross-workspace move
protocol or claim atomicity across independent authorities. The first
destination is deliberately undecided.

## Consequences

Tab Manager has one sentence and one durable collection. It remains useful
across devices because captures synchronize, not because devices are modeled.
The browser extension can be rebuilt without migrating device, bookmark,
tool-trust, or conversation history into the new data version.

Permanent bookmarks, AI processing, and promotion destinations may return only
as separately justified product features. Until then, the inbox is intentionally
consumable rather than a second bookmark library.
