# Greenfield thinking

State what the system enables, then show its natural use. Work backward from
that use to ownership: which object owns the lifetime, which representation is
authoritative, and which layer enforces each important invariant?

Make the caller honest. An attractive `openWorkspace()` can conceal decisions
about credentials, persistence, or cleanup that its consumer needs to control.
Show how those decisions are made. If the caller must combine unrelated concepts
or surrender consequential policy merely to enter the API, reconsider the
boundary.

Trace callers, exports, and wrappers upward to the user-visible workflow. Follow
important values through creation, mutation, repair, caching, serialization, and
interpretation. Identify competing owners or representations using actual
symbols and consumers. Check stored shapes, tests, and decision records to
understand the tradeoffs they embody; the current request may change them.

Look for duplicated state, repair in read paths, optional fields preserving old
shapes, adapters between concepts that could be one, and exported contracts with
no real consumer. These are evidence to investigate, not automatic deletions.

Make the target recognizable through observable facts. For example, saying
"auth owns the session lifetime" should predict where credentials change, how
requests receive them, and what happens to in-flight work at sign-out. If those
questions still require a second owner, the destination needs more thought.

Work backward from the developed target to the constraints it must meet.
Existing user data, external consumers, and security properties reveal work the
transition must account for. Establish which limits are demonstrated and which
are assumptions still worth challenging. When a real limit changes the vision,
show its consequence and develop the revised destination together.
