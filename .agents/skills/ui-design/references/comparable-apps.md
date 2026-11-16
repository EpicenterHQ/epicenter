# Comparable Apps

Use this reference when planning a user-facing surface whose category pattern
is not obvious. The comparison is a coherence gate, not market research or a
vote.

## Core Move

Before choosing the design, name three to five comparable apps and write one
line each about how they handle the same concrete question. Include both the
category Epicenter belongs to and the category the proposal risks drifting
toward.

```txt
question -> comparable categories -> visible pattern -> borrow or refuse
```

The comparison should make a conventional choice unsurprising or make a
deliberate deviation explicit. A load-bearing reason can override the pattern;
the table exposes the cost of doing so.

## Category Lens

```txt
COMMUNICATION-FIRST    identity is the product; identity stays prominent
CREDENTIAL VAULT       identity disambiguates the secret store being unlocked
INFRA / IDENTITY TOOL  identity disambiguates the network or tenant
TOOL WITH IDENTITY     identity belongs to the workspace and stays recessive
IDE                    identity supports authoring and sync, then disappears
LOCAL-FIRST WORKSPACE  the workspace is primary; identity is configuration
```

Start with the app the person is using. An app served from their Epicenter
runs on their home. An outside app such as Whispering has its own account
and storage choices. Pick comparisons that fit that app's task.

## Method

1. State the design question concretely. Ask where an email appears and whether
   it persists, not what the auth UI should look like.
2. Pick three to five apps across at least two relevant categories.
3. Write one line per app in a table with only the columns the question needs.
4. State which pattern Epicenter borrows and which it refuses.
5. When the refusal may delete disproportionate complexity, use
   [asymmetric-wins](../../asymmetric-wins/SKILL.md).

Common useful questions include whether identity appears in chrome, whether
sync status is prominent, whether the app supports account switching, whether
it opens a workspace picker, and where preferences persist.

## Guardrails

- Do not list one app and call it a comparison.
- Do not select only apps from Epicenter's own category; include the category
  the design could drift toward.
- Do not compare apps that lack the surface being designed.
- Put the table before convergence. Afterward it is only a sanity check.
- Treat the result as evidence, not authority.

The move succeeds when a reader can tell from the table whether the proposal
fits Epicenter's category and which deviation, if any, is intentional.
