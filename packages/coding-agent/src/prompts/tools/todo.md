**Tasks: verbatim content strings, NEVER auto-generated IDs; no "task-1"/"task-N". Pass content in `task`.**

After each successful state-changing op: if nothing is `in_progress`, the earliest `pending` task (phase order) auto-promotes to `in_progress`; if several are `in_progress`, only the earliest stays. Blocked tasks NEVER auto-promote—`unblock` first. Out-of-order completion may move pointer back to an earlier phase—expected; completed tasks NEVER revert.

## Operations

|`op`|Fields|Effect|
|---|---|---|
|`init`|`list: [{phase, items: string[]}]`|Initialize full list; replaces existing|
|`init`|`items: string[]`|Flattened single-phase init|
|`start`|`task`|Mark in progress|
|`done`|`task` or `phase`|Mark completed|
|`drop`|`task` or `phase`|Mark abandoned|
|`block`|`task` or `phase`; optional `reason`|Mark blocked: awaiting external input; never auto-promotes; excluded from stop-time incomplete-todo reminder|
|`unblock`|`task` or `phase`|Blocked task → `pending`|
|`rm`|optional `task` or `phase`|Remove task/phase; omit both → clear|
|`append`|`phase`; `items: string[]`|Append tasks to phase; lazily creates phase|
|`view`|—|Read-only; echo list|

## Anatomy

- Task content: concise, descriptive, and unique; it is the identifier.
- Phase name: short noun phrase (e.g. `Foundation`, `Auth`, `Verification`); unique identifier. NEVER prefix `1.`, `A)`, `Phase 1:`.

## Rules

- Update status at meaningful checkpoints. A pending list records unfinished work; it does not require you to keep working or prevent you from replying to the user.
- Use `block` for a real dependency, not merely because you are pausing the conversation. Blocking the active task hands `in_progress` to the next `pending` task; use `unblock` when the dependency clears.
- Keep introduced `task`/`phase` strings stable.
- Lost exact task text: `view` echoes list; NEVER guess from memory.

## When to use

- Create a list when the user requests one or when tracking it materially helps preserve scope across substantial work. A short multi-step task or a conversational list does not automatically need todos.
- Preserve every requested outcome, whether or not it has its own todo row. Do not silently drop scope to simplify the list.
- When the user changes direction, address the message first; reconcile the list with the agreed direction afterward. Bookkeeping is not a prerequisite for conversation.
