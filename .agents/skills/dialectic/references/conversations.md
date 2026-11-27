# Example conversations

These illustrative conversations show how the agent and user agree on an
intent, articulate a vision, and work backward from it.

## Database settings: reconsider a stable handle

This conversation and app are hypothetical.

**User:** Changing the database settings means opening a new handle. Components
keep references to the old one. I'm thinking of a permanent wrapper that swaps
the underlying handle and reattaches subscriptions.

**Agent:** Here's how I understand the intent.

> Make changed settings take effect correctly while preserving the user's work.

**User:** Say “saved work.” These settings live on a separate page, and
the user will have finished editing before they get there. Their saved
data is what matters.

**Agent:** Here's the intent with that clarified.

> Make changed settings take effect while preserving the user's saved work.

**User:** That's right.

**Agent:** Here's what I picture.

> The user applies the settings. The app briefly reloads and opens with
> the new settings and all their saved work.

**User:** That's right. A brief reload is fine here. How would we make that
work?

**Agent:** We can use the app's normal startup path. It already opens the
database and gives components their handle.

```text
Save the settings
→ wait for saving to succeed
→ reload the page
→ normal startup opens the database with the new settings
```

To check the result, change the settings and verify that the app comes back
with the new settings and the same saved work.

## Blog writing: compare the rendered openings

This illustrative exchange draws on the blog-opening comparison discussed in
conversation `01a0c8c6-13fa-7903-9877-946764e5e8d3`. The wording and
follow-up are illustrative. The italicized actions stand in for screenshots.

> **Human:** We've revised the opening several times and I can't tell whether
> it's getting better. Can I see the versions side by side?
>
> **Agent:** Here's how I understand the intent.
>
> > Choose the opening that gives readers the clearest way into the idea.
>
> **Human:** That's right.
>
> **Agent:** Here's what I'd want you to see.
>
> > Three versions of the opening side by side as they'd appear on the blog,
> > each with the transition into the next section. You can read them the way
> > a reader would and see where each one lands you.
>
> **Human:** That's right. Show me that.
>
> *The agent renders all three openings on the blog and shows labeled previews
> together, including the transition into the next section.*
>
> **Agent:** The code-first version gets to a concrete example sooner. The
> ASCII-first version shows the whole chain before asking readers to follow
> the code. I'd start with code-first for someone skimming, but its longer
> code block pushes the explanation farther down the page.
>
> **Human:** Code-first is clearer, but now I see why the quote underneath
> feels repetitive. Keep the opening sentence and code. Try a shorter quote.
>
> *The agent changes only the quote, renders it in place, and shows the previous
> and revised previews together.*
>
> **Agent:** Here's the shorter quote in place. It explains the change from
> returning a result to acting on it, without repeating the opening rule.

The rendered comparison lets the user judge how the prose, code, quotation,
and spacing work together. Once the user chooses the opening sentence and code,
the next revision carries both forward.
