---
name: github-issues
description: 'GitHub issue comment guidelines for community interaction. Use when: "respond to this issue", "reply to this bug report", "close this issue", or any GitHub discussion.'
metadata:
  author: epicenter
  version: '1.0'
---

# GitHub Issue & PR Comment Guidelines

## Anti-Patterns (Avoid These)

- **Over-structured responses**: Don't use headers, numbered sections, or bullet lists for simple replies. A conversational paragraph is usually better.
- **Formulaic openings**: Don't start every comment identically. Match the tone to the conversation.
- **Restating what's obvious**: If someone asked a question, just answer it. Don't recap what they said.
- **Corporate announcements**: "We are pleased to announce..."; just say what changed.
- **Over-explaining closed-loop fixes**: If the issue is fixed and there is no action needed from the reporter, do not make them read release-process details.

Follow the [project writing conventions](../../../AGENTS.md#writing-conventions).

## Maintainer Respect Gate

Assume issue reporters and maintainers are busy. The most respectful comment is usually the shortest one that closes the loop clearly.

### Comment Compression Rule

Before drafting, ask: what does the reader need to know or do next? Include only that.

Most comments need this shape:

1. Human acknowledgment.
2. Current state or direct answer.
3. Next action, only if there is one.
4. Warm closing.

Warmth should be visible but light. Prefer one exclamation point at the end of the opening or closing sentence. The closing is usually the best place: "Thanks again for catching it!"

Do not add internal process details unless the reader needs them to verify the answer or take the next step.

### Fixed Issues

For fixed issues, use this order:

1. Thank them for flagging it.
2. Say the current state directly.
3. Mention the concrete version, release, PR, or commit only if it helps them verify.
4. Close with brief gratitude, usually with one exclamation point.

Avoid validating the reporter's correctness unless it helps the reply. Usually, thank them and state the current status. Do not explain internal mechanics unless the issue is about those mechanics or the user needs them to verify the fix.

Good:

```
Hey @username, thank you for flagging this.

This has been fixed, and current releases now include npm provenance attestations.

Thanks again for catching it!
```

## Opening Pattern

Open your first reply on a thread with a personal greeting using the user's GitHub handle (ongoing back-and-forth can skip it):

- "Hey @username, thank you for the issue"
- "Hey everyone, thanks for the notice!"
- "Hey all, thanks for the issue!"

## Core Elements

### 1. Acknowledgment

- Start by acknowledging their issue/contribution
- Express empathy for problems: "sorry to hear this!", "sorry to hear your shortcut was lost!"
- Apologize for delays: "I apologize for the delayed response"

### 2. Good News Delivery

When announcing features or fixes:

- "good news!" or "Good news!"
- Add celebration emoji sparingly
- Credit contributors: "Thank you for the inspiration" or "Thank you and @user1 and @user2 for the inspiration"

### 3. Debugging Offers

For complex issues, offer direct help:

- "If you have time, I would love to hop on a call with you, and we can debug this together"
- "Let's hop on a call sometime in the coming days, and I'll debug it with you"
- When offering a call, include the cal.com link: "https://cal.com/epicenter/whispering"
- Do not claim specific availability ("I'm free as early as tomorrow") you cannot verify

### 4. Discord Promotion

Occasionally, when the reporter seems invested in the project, invite them to Discord:

- "PS: I've also recently created a Discord group, and I'd love for you to join! You can ping me directly for more features."
- Include link: "https://go.epicenter.so/discord"

### 5. Follow-up Questions

Ask clarifying questions to understand the issue better. Ask for whatever is missing: exact version, platform, and the smallest reproduction.

- "To clarify, could you confirm that this issue persists even with the latest installer?"
- "Could you share which OS and version you're on?"

### 6. Closing

End with gratitude:

- "Thank you!"
- "Thanks again!"
- "Thank you again for your help and will be taking a look!"
- "My pleasure!" (when thanked)

## Response Examples

### Feature Implementation Response

```
Hey @username, thank you for the issue, and good news! [The latest release](link) now includes the [feature]! Thank you for the inspiration.

[Brief description of how it works]

PS: I've also recently created a Discord group, and I'd love for you to join! You can ping me directly for more features.

https://go.epicenter.so/discord
```

### Debugging Response

```
Hey @username, so sorry to hear this! I apologize for the delayed response; I was finalizing [the latest release](link).

To clarify, could you confirm that this issue persists even with the latest installer?

If you have time, I would love to hop on a call with you, and we can debug this together. You can book a meeting with me using my cal.com link right here:

https://cal.com/epicenter/whispering

Thank you!
```

### Quick Acknowledgment

```
Hey @username, sorry to hear [problem]! Did you ever get a fix?
```

### PR Discussion (back-and-forth)

```
Good catch! Updated to only clear the dev app cache in nuke mode.

The flow is now:
- `bun clean`: artifacts and node_modules
- `bun nuke`: above + Rust targets + dev cache

Let me know if you want a confirmation prompt before clearing.
```

## Writing Style Notes

- Reference specific users and give credit; link to relevant issues, releases, or commits
- PR comments can be brief: ongoing discussions don't need full greetings/closings
- Match the energy: short question gets short answer, detailed report gets detailed response
