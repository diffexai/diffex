> Diffex can help you create Diffex packages. Ask it to bundle your extensions, skills, prompt templates, or themes.

# Diffex Packages

Diffex packages bundle extensions, skills, prompt templates, and themes so you can share them through npm or git. A package can declare resources in `package.json` under the compatibility `diffex` key, or use conventional directories.

## Table of Contents

- [Install and Manage](#install-and-manage)
- [Package Sources](#package-sources)
- [Creating a Diffex Package](#creating-a-diffex-package)
- [Package Structure](#package-structure)
- [Dependencies](#dependencies)
- [Package Filtering](#package-filtering)
- [Enable and Disable Resources](#enable-and-disable-resources)
- [Scope and Deduplication](#scope-and-deduplication)

## Install and Manage

> **Security:** Diffex packages run with full system access. Extensions execute arbitrary code, and skills can instruct the model to perform any action including running executables. Review source code before installing third-party packages.

```bash
diffex install npm:@foo/bar@1.0.0
diffex install git:github.com/user/repo@v1
diffex install https://github.com/user/repo  # raw URLs work too
diffex install /absolute/path/to/package
diffex install ./relative/path/to/package

diffex remove npm:@foo/bar
diffex list                     # show installed packages from settings
diffex update                   # update Diffex only
diffex update --all             # update Diffex, update packages, and reconcile pinned git refs
diffex update --extensions      # update packages and reconcile pinned git refs only
diffex update --models          # refresh model catalogs only
diffex update --self            # update Diffex only
diffex update --self --force    # reinstall Diffex even if current
diffex update npm:@foo/bar      # update one package
diffex update --extension npm:@foo/bar
```

These commands manage Diffex packages and `diffex update` can update the Diffex CLI installation. To uninstall Diffex itself, see [Quickstart](quickstart.md#uninstall).

In an interactive terminal, `install` asks whether to install globally or for the current workspace and shows the settings and package-storage destinations plus the security implications. Workspace installation requires project trust; cancellation, an untrusted workspace, or an unwritable destination never falls back to global installation. In non-interactive environments, `install` retains its global default. Pass `-l` to choose workspace scope explicitly without a scope prompt.

`remove` writes to user settings (`~/.diffex/agent/settings.json`) by default; use `-l` for project settings (`.diffex/settings.json`). Project settings can be shared with your team, and Diffex installs any missing packages automatically on startup after the project is trusted.

To try a package without installing it, use `--extension` or `-e`. This installs to a temporary directory for the current run only:

```bash
diffex -e npm:@foo/bar
diffex -e git:github.com/user/repo
```

## Package Sources

Diffex accepts three source types in settings and `diffex install`.

### npm

```
npm:@scope/pkg@1.2.3
npm:pkg
```

- Versioned specs are pinned and skipped by package updates (`diffex update --extensions`, `diffex update --all`).
- User installs go under `~/.diffex/agent/npm/`.
- Project installs go under `.diffex/npm/`.
- Set `npmCommand` in `settings.json` to pin npm package lookup and install operations to a specific wrapper command such as `mise` or `asdf`.
- Homebrew payloads default to private npm invoked with bundled Node; an explicit `npmCommand` takes precedence. Extension subprocesses can locate bundled Node without a system Node/npm installation. Packages still install in the user/project directories above, never the immutable Homebrew application. Git and native build tools may remain external prerequisites.

Example:

```json
{
  "npmCommand": ["mise", "exec", "node@20", "--", "npm"]
}
```

### git

```
git:github.com/user/repo@v1
git:git@github.com:user/repo@v1
https://github.com/user/repo@v1
ssh://git@github.com/user/repo@v1
```

- Without `git:` prefix, only protocol URLs are accepted (`https://`, `http://`, `ssh://`, `git://`).
- With `git:` prefix, shorthand formats are accepted, including `github.com/user/repo` and `git@github.com:user/repo`.
- HTTPS and SSH URLs are both supported.
- SSH URLs use your configured SSH keys automatically (respects `~/.ssh/config`).
- For non-interactive runs (for example CI), you can set `GIT_TERMINAL_PROMPT=0` to disable credential prompts and set `GIT_SSH_COMMAND` (for example `ssh -o BatchMode=yes -o ConnectTimeout=5`) to fail fast.
- Refs are pinned tags or commits. `diffex update --extensions` and `diffex update --all` do not move them to newer refs, but they do reconcile an existing clone to the configured ref.
- Use `diffex install git:host/user/repo@new-ref` to update settings and move an existing package to a new pinned ref.
- Cloned to `~/.diffex/agent/git/<host>/<path>` (global) or `.diffex/git/<host>/<path>` (project).
- When reconciliation changes the checkout, Diffex resets and cleans the clone, then runs `npm install` if `package.json` exists.

**SSH examples:**
```bash
# git@host:path shorthand (requires git: prefix)
diffex install git:git@github.com:user/repo

# ssh:// protocol format
diffex install ssh://git@github.com/user/repo

# With version ref
diffex install git:git@github.com:user/repo@v1.0.0
```

### Local Paths

```
/absolute/path/to/package
./relative/path/to/package
```

Local paths point to files or directories on disk and are added to settings without copying. Relative paths are resolved against the settings file they appear in. If the path is a file, it loads as a single extension. If it is a directory, Diffex loads resources using package rules.

## Creating a Diffex Package

Add a `diffex` manifest to `package.json` or use conventional directories. Include the `diffex-package` keyword for discoverability.

```json
{
  "name": "my-package",
  "keywords": ["diffex-package"],
  "diffex": {
    "extensions": ["./extensions"],
    "skills": ["./skills"],
    "prompts": ["./prompts"],
    "themes": ["./themes"]
  }
}
```

Paths are relative to the package root. Arrays support glob patterns and `!exclusions`.

### Package Discovery Metadata

Include the `diffex-package` keyword so Diffex packages are discoverable through [npm search](https://www.npmjs.com/search?q=keywords%3Adiffex-package). For compatibility with upstream package indexes, packages can also include optional `video` or `image` preview metadata:

```json
{
  "name": "my-package",
  "keywords": ["diffex-package"],
  "diffex": {
    "extensions": ["./extensions"],
    "video": "https://example.com/demo.mp4",
    "image": "https://example.com/screenshot.png"
  }
}
```

- **video**: MP4 preview URL.
- **image**: PNG, JPEG, GIF, or WebP preview URL.

If both are set, upstream package indexes prefer the video.

## Package Structure

### Convention Directories

If no `diffex` manifest is present, Diffex auto-discovers resources from these directories:

- `extensions/` loads `.ts` and `.js` files
- `skills/` recursively finds `SKILL.md` folders and loads top-level `.md` files as skills
- `prompts/` loads `.md` files
- `themes/` loads `.json` files

## Dependencies

Third party runtime dependencies belong in `dependencies` in `package.json`. Dependencies that do not register extensions, skills, prompt templates, or themes also belong in `dependencies`. When Diffex installs a package from npm or git, it runs `npm install`, so those dependencies are installed automatically.

Diffex bundles core packages for extensions and skills. If you import any of these, list them in `peerDependencies` with a `"*"` range and do not bundle them: `@diffexai/diffex-ai`, `@diffexai/diffex-agent-core`, `@diffexai/diffex`, `@diffexai/diffex-tui`, `typebox`.

Other Diffex packages must be bundled in your tarball. Add them to `dependencies` and `bundledDependencies`, then reference their resources through `node_modules/` paths. Diffex loads packages with separate module roots, so separate installs do not collide or share modules.

Example:

```json
{
  "dependencies": {
    "shitty-extensions": "^1.0.1"
  },
  "bundledDependencies": ["shitty-extensions"],
  "diffex": {
    "extensions": ["extensions", "node_modules/shitty-extensions/extensions"],
    "skills": ["skills", "node_modules/shitty-extensions/skills"]
  }
}
```

## Package Filtering

Filter what a package loads using the object form in settings:

```json
{
  "packages": [
    "npm:simple-pkg",
    {
      "source": "npm:my-package",
      "extensions": ["extensions/*.ts", "!extensions/legacy.ts"],
      "skills": [],
      "prompts": ["prompts/review.md"],
      "themes": ["+themes/legacy.json"]
    }
  ]
}
```

`+path` and `-path` are exact paths relative to the package root.

- Omit a key to load all of that type.
- Use `[]` to load none of that type.
- `!pattern` excludes matches.
- `+path` force-includes an exact path.
- `-path` force-excludes an exact path.
- Filters layer on top of the manifest. They narrow down what is already allowed.

## Enable and Disable Resources

Use `diffex config` to enable or disable extensions, skills, prompt templates, and themes from installed packages and local directories. `diffex config` starts in global settings (`~/.diffex/agent/settings.json`); press Tab to switch between global and project-local modes. Use `diffex config -l` to start in project overrides (`.diffex/settings.json`) with inherited global resources dimmed. Interactive sessions also expose installed-skill inspection and toggles under **Installed skills** in `/settings`; use `/reload` after changing them.

## Scope and Deduplication

Packages can appear in both global and project settings. If the same package appears in both, the project entry wins unless the project entry has `autoload: false`, in which case it is applied as a delta over the global entry. Project-installed skills take precedence over user and package skills with the same name. An installed skill also retains the unsuffixed name when it collides with an evolved skill. See [Skills](skills.md) for complete catalog and collision rules.

Identity is determined by:

- npm: package name
- git: repository URL without ref
- local: resolved absolute path
