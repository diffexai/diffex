# Background process lifetime

Local shell commands normally belong to their Diffex session.
Abort, disposal, print-mode exit, and normal subagent completion terminate surviving background jobs, including jobs started with `nohup`.

An environment supervisor can explicitly take responsibility for successful background jobs on Linux and macOS:

```sh
diffex --print \
  --background-process-lifetime=environment \
  --background-process-ownership-dir=/run/trial/diffex-shell-ownership \
  "Start the task service"
```

The default lifetime is `session`.
Environment lifetime requires an explicit ownership directory and applies to all built-in local bash executions, direct session bash commands, and child sessions in that invocation.
Relative CLI directory paths are resolved against the initial working directory, including after session replacement.
Custom or remote `BashOperations` implementations manage their own process lifecycle.

A shell process group becomes environment-owned only when its launching shell exits with code `0` before cancellation or timeout.
Handoff happens at shell exit, before the next provider request or final assistant response.
Failed commands and active commands remain session-owned.
Once handed off, background processes survive later provider errors, interruption, child failure, session replacement, and disposal.
The failed or interrupted invocation still retains its failure outcome.

The environment supervisor must terminate transferred processes when the environment is destroyed.
Services should redirect their output to files: environment mode bounds inherited stdout/stderr draining to 100 milliseconds after shell exit so a continuously logging service cannot hold the CLI open.

## SDK

```ts
const { session } = await createAgentSession({
  backgroundProcessPolicy: {
    lifetime: "environment",
    ownershipDirectory: "/run/trial/diffex-shell-ownership",
  },
});
```

The same option is available on `AgentSessionConfig` and `createAgentSessionFromServices`.
SDK ownership directories must be absolute.
Runtime factories should capture this invocation-level policy and pass it to each replacement session.
Child sessions inherit the parent policy, including children restored within the invocation.

## Supervisor handoff records

Use a separate ownership directory for each environment execution.
Diffex writes one versioned JSON file per shell execution, named `<executionId>.json`.
The execution ID also appears in the inherited `DIFFEX_SHELL_EXECUTION_ID` environment variable.
Records contain `version: 1`, `executionId`, `processGroupId`, `supervisorPid`, `owner`, `state`, and a snapshot of live `members`.
Each member contains its PID, process group ID, and process start identity.
Linux identities combine the boot ID and `/proc/<pid>/stat` start ticks; macOS identities use `ps lstart` in UTC and the C locale.

The initial record is `owner: "session", state: "active"`.
Successful handoff replaces it with `owner: "environment", state: "background"`.
Confirmed termination of an untransferred group records `owner: "session", state: "terminated"`.
Member snapshots are evidence at publication time, not a continuously updated process inventory.

Each replacement is flushed to a temporary file and atomically renamed before the process group is removed from session and global shutdown tracking.
Only the completed `.json` file establishes ownership; ignore `.tmp` files.
The atomic rename is the handoff commit point, so a supervisor can recover ownership after a CLI crash or SIGKILL without depending on session-history flushing or a successful final response.
Publication failure leaves ownership with Diffex and fails the shell operation.
Publication and in-memory release contain no asynchronous boundary, so ordinary cancellation cannot interleave with the handoff.

A supervisor must validate current process identities before signaling or preserving a recorded group and follow inherited execution markers for newly created descendants.
Never signal a numeric PID or group ID from a stale record without checking identity.
Missing, invalid, or ambiguous records are not proof of an environment handoff.
Records are a cooperation protocol within the trusted trial environment, not a security boundary against task code that can modify that environment.

## Terminal-Bench integration

This option provides the Diffex ownership boundary described by process-lifetime issue 1.
The adapter must enable it for every task once its pinned Diffex release supports these flags and its pre-verifier cleanup consumes the ownership records.
The separate adapter cleanup change in issue 2 is still required: marker-based cleanup that kills all trial processes will also kill transferred services.
Final environment deletion remains responsible for removing task services after verification.
