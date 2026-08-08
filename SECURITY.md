# Security Policy

This document explains the Diffex security model and its boundaries.

Diffex is a coding agent that runs locally within the security boundary of the user running it.
The user is responsible for monitoring its operations or containing it within a container, virtual machine, or other sandbox solution.

Diffex treats the local user account and files writable by that account as inside the same trust boundary as the Diffex process itself.
If an attacker can modify files under the user's home directory, workspace, shell startup files, environment, or Diffex configuration, they can generally influence Diffex or other local developer tools.
Reports that depend on such prior local write access are not security vulnerabilities unless they demonstrate how Diffex grants that write access or crosses an operating-system privilege boundary.

Diffex relies on users installing trustworthy extensions and skills and using it only within trusted repositories.
Files such as `AGENTS.md` and instructions in comments can prompt-inject the coding agent, and this cannot be prevented reliably.

## Reporting a Vulnerability

If you believe you found a security vulnerability in Diffex or another package in this repository, open a private report through GitHub Security Advisories for this repository.

Please include:

- A description of the issue and its impact
- Steps to reproduce, proof of concept, or relevant logs
- The affected package, version, commit, or configuration
- Any known mitigations

Do not open a public issue for security-sensitive reports.
We will review reports and coordinate disclosure as appropriate.

## Scope

Security issues in the distributed packages, command-line tools, APIs, and repository code are in scope.

## Out of Scope

- Local code execution or sandboxing behavior because the Diffex coding agent intentionally does not include a sandbox
- Behavior of Diffex extensions or skills installed by the user
- Risks from working in untrusted repositories
- Risks from installing untrusted extensions, skills, packages, or tools
- Issues caused by untrustworthy man-in-the-middle proxies
- Public internet exposure of a Diffex installation
- Prompt injection attacks
- Exposed secrets that are third-party or user-controlled credentials
- Reports requiring the ability to create, modify, delete, or replace files, directories, symlinks, environment variables, shell configuration, or other user-controlled local state on the target machine
  This includes `~/.pi`, `~/.pi/agent/models.json`, workspace files, `AGENTS.md`, skills, extensions, extension configuration, dotfiles, and files synchronized through NFS, roaming profiles, or dotfile managers, unless the report shows how Diffex itself grants that access.
- Issues caused by intentionally weakened user configuration
- Resource or denial-of-service claims that require trusted local input or configuration against the Diffex coding agent
- Reports about malicious model output
- User-approved or user-initiated local actions presented as vulnerabilities

## Notes for Reporters

The most useful reports show a current, reproducible security boundary bypass with demonstrated impact.
Reports that only show expected local-agent behavior, prompt injection, or a malicious trusted extension or skill are not security vulnerabilities under this model.

For example, a report showing that malicious contents written to a trusted Diffex configuration file cause Diffex to execute commands, load attacker-controlled tools, send credentials to an attacker-controlled endpoint, or otherwise change behavior is out of scope.

When possible, include the exact affected path, package version or commit SHA, configuration, and a proof of concept against the latest release or latest `main`.
For dependency reports, include evidence that the shipped dependency is affected and that the issue is reachable through Diffex.
For exposed-secret reports, include evidence that the credential is owned by the project and exposed through the repository or distributed product.
