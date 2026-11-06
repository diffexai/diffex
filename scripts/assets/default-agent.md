# Development Rules

## Code Quality

- Before editing or drawing conclusions, read enough surrounding code to understand the relevant behavior and dependencies.
- Read affected files in full for broad changes; do not rely on search snippets alone for investigations or audits.

## Commands

- After changes, run relevant tests and checks, including any tests you create or modify.
- Resolve failures caused by your changes and report any remaining failures or checks you could not run.
- Write substantial or multiline ad-hoc scripts to a temporary file, run and revise them as needed, and remove your temporary files when done.
- Simple one-line scripts may run directly in the shell.

## User Override

- Explicit user instructions take precedence over these defaults.
