# 0938. An action says whether agents are offered it

- **Status:** Proposed
- **Date:** 2026-11-17
- **Supersedes:** [ADR-0907](0907-private-input-is-a-whole-call-handling-policy.md) (private input as a whole-call policy), once accepted.
- **Relates:** [ADR-0870](0870-an-apps-secrets-are-local-files-and-a-local-file-never-leaves-its-computer.md) (where a secret is kept), [ADR-0930](0930-an-action-call-is-a-function-call-and-serve-keeps-nothing-about-it.md) (one way to call an action).

## Context

ADR-0907 let an action declare `privateInput: true`. The flag did four
things: MCP neither listed nor ran the action, the CLI took its input only on
stdin, a validation refusal named no key or value, and a routine could not
save it.

Messages is the only app that used it, on four actions. One, `connect`,
takes a Beeper token. The other three, `send`, `deliver` and `syncDraft`,
carry no secret. They used the flag to keep "send a message as me" out of
the tools an agent is offered, because that agent also reads messages from
strangers, and text from a stranger beside a send tool is how an agent is
talked into sending something.

So the flag held two ideas. Keeping a token out of places that keep text was
never needed: the page posts the token to serve as it posts any input, the
action writes it to a file that never enters Git, and no refusal printed a
value. Keeping an action away from agents was the part in use.

## Decision

**An action may declare `mcp: false`, and then serve does not offer it to
agents. No input is private.**

- `tools/list` leaves the action out, and `tools/call` for its name is
  refused before anything runs.
- Every other caller treats it as any action: the CLI, HTTP, the app's
  pages and routines.
- `privateInput` is gone. It is an unknown key and is refused at
  declaration, so an app that still declares it does not load until the line
  is removed or becomes `mcp: false`.
- A secret is ordinary input the first time, from the app's page or piped on
  stdin, and the action keeps it in a file that is never committed
  (ADR-0870).

## Consequences

- The key is read in one file, `mcp.ts`, and shown in listings. The CLI,
  input checking and routines lose their special cases.
- It shapes what an agent is offered and is not a wall. An agent with a
  shell can call the action through the CLI or HTTP, as it could before:
  serve does not know who is calling.
- `epicenter messages connect '{"token":"..."}'` works and leaves the token
  in shell history. The page, or `-` with the JSON piped in, does not.
- A refusal for an action that takes a secret can name a key. It does not
  print the value, which no refusal does.

## Considered alternatives

- **Keep `privateInput` whole.** Three of its four effects guarded the owner
  against the owner's own choices, and each was a special case in a
  different caller.
- **Offer every action and rely on the description.** Mail's `apply` does
  this today. It leaves the decision to an agent that has just read
  untrusted text.
- **A fifth MCP annotation.** MCP has no hint for "do not list this", and
  the four it has are passed through as the author wrote them.
- **Serve knows who is calling and refuses agents.** It would make the key a
  wall. Serve has no caller identity on loopback, and adding one is a larger
  change than this problem needs.
