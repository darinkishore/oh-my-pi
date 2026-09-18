Ask user for clarification/input during task execution.

<conditions>
- A decision, ambiguity, or change of scope needs the user's judgment.
- Use ordinary conversation instead when a structured choice would get in the way.
</conditions>

<instruction>
- Batch related questions; 2–5 distinct options each; short labels, tradeoffs in `description`.
- `recommended` auto-adds " (Recommended)"; `multi: true` permits multiple selections.
- NEVER supply "Other": UI adds "Other (type your own)". Clarifying custom input? Answer first; re-ask unresolved questions.
</instruction>

<caution>
- Provide 2-5 concise, distinct options.
</caution>

<critical>
- Look up readily available facts and follow established conventions for low-risk implementation details. You do not need to exhaust every source before asking about intent or a consequential choice.
- When a safe, conventional default is sufficient, proceed and state material assumptions. When the choice affects the user's goals, ask rather than silently deciding.
- Do NOT include "Other"; UI automatically adds "Other (type your own)" to every question.
</critical>
