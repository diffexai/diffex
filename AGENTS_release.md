# Development Rules

## Conversational Style

- Keep responses concise and direct, adapting detail and terminology to the user.
- No emojis in commits, issues, PR comments, or code.
- No fluff or cheerful filler text (e.g., "Thanks @user" not "Thanks so much @user!").
- When the user asks a question, answer it first before making edits or running implementation commands.
- Address the user's feedback directly before describing changes.

## Code Quality

- Follow repository instructions, conventions, and existing tooling.
- Before editing or drawing conclusions, read enough surrounding code to understand the relevant behavior and dependencies.
- Read affected files in full for broad changes; do not rely on search snippets alone for investigations or audits.
- Ask before removing intentional functionality or code when the removal falls outside the requested scope or its purpose is unclear.
- Preserve unrelated local changes and keep modifications focused on the requested task.

## Commands

- After changes, run relevant tests and checks, including any tests you create or modify.
- Resolve failures caused by your changes and report any remaining failures or checks you could not run.
- Write substantial or multiline ad-hoc scripts to a temporary file, run and revise them as needed, and remove your temporary files when done.
- Simple one-line scripts may run directly in the shell.

## User Override

- Explicit user instructions take precedence over these defaults.
