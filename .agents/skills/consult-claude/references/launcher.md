# Claude launcher reference

The shared launcher requires Bun, Git, and an authenticated Claude Code
installation with access to the selected model. Consultation uses Claude Code
2.1.280 or later. For launcher changes, check the installed `claude --version`
and `claude --help` against the [CLI reference](https://code.claude.com/docs/en/cli-reference)
and [programmatic usage](https://code.claude.com/docs/en/headless).

## Choose a subscription account

`personal` uses the native default login. `work` uses `~/.claude-work`.
Use the verified Claude email for the selected profile on every turn. Get it
from that profile's native auth status. The launcher clears inherited Anthropic
credentials and provider overrides, then checks the profile, paid Claude
subscription, and email before sending the brief. `--dry-run` previews the
launch arguments and selected profile without checking login or calling Claude.

For a new work login, clear any conflicting authentication overrides and run
the native login with the user's work email. The user completes the browser
login and verifies the Claude email.

```bash
CLAUDE_CONFIG_DIR="$HOME/.claude-work" claude auth login --claudeai --email "work@example.com"
```

Keep profile changes out of active launches. Leave `CLAUDE_CONFIG_DIR` unset for
the default personal login. On macOS, setting it explicitly to `~/.claude`
selects a different Keychain entry. [Claude Code multiple-account guidance](https://code.claude.com/docs/en/authentication#log-in-with-multiple-accounts)

## Diagnose a missing macOS login

The Codex workspace sandbox can hide the Claude Code Keychain login. If
`claude auth status` reports `loggedIn: false` inside the sandbox, check the
same profile outside it before changing the login. If that succeeds, run the
launcher and follow-ups with a per-command sandbox exception. Keep the
launcher's restrictions for the selected mode in place, keep credentials in
native Claude storage, and retain the task's existing sandbox settings.

## Prepare source for a review

Keep the reviewed files stable during each turn. If other edits are in flight,
use a snapshot containing the relevant committed, uncommitted, and untracked
files. Put prototype evidence inside the checkout Claude will read. When
reviewing a delegated clone, run from the clone and invoke the launcher by its
absolute path in the coordinating checkout. This keeps the launcher's access
rules outside the code under review.

## Record a session for continuation

If an assignment may outlive the current context, keep its native `session_id`,
account and verified email, absolute checkout, mode, actual model, and chosen
effort in the existing task notes. For a delivery, add the workspace choice,
source baseline, allowed or transferred paths, completed checks, blocker, and
next step. For Codex assistance, record the helper model, limits, write roots,
and returned helper IDs. Update the same notes as work proceeds. Claude and
Codex keep the full conversations in their native sessions.
