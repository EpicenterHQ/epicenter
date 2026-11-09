@AGENTS.md

# Claude-specific notes

`/codex:rescue`, `/codex:review`, `/codex:adversarial-review`, `/codex:transfer`,
`/codex:status`, `/codex:result`, and `/codex:cancel` remain user-invoked and
cannot be called automatically. Use them only when the user explicitly asks
for that separate Codex-plugin workflow. Launcher-provided Codex assistance is
a separate, host-bounded capability described in the delegation skills.
