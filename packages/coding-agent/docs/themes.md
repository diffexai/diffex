> Diffex can create themes. Ask it to build one for your setup.

# Themes

Themes are JSON files that define colors for the TUI.

## Table of Contents

- [Locations](#locations)
- [Selecting a Theme](#selecting-a-theme)
- [Creating a Custom Theme](#creating-a-custom-theme)
- [Theme Format](#theme-format)
- [Color Tokens](#color-tokens)
- [Color Values](#color-values)
- [Tips](#tips)

## Locations

Diffex loads themes from:

- Built-in: `dark`, `light`
- Global: `~/.diffex/agent/themes/*.json`
- Project: `.diffex/themes/*.json` (only after the project is trusted)
- Packages: `themes/` directories or `diffex.themes` entries in `package.json`
- Settings: `themes` array with files or directories
- CLI: `--theme <path>` (repeatable)

Disable discovery with `--no-themes`.

## Selecting a Theme

Select a theme via `/settings` or in `settings.json`:

```json
{
  "theme": "my-theme"
}
```

On first run, Diffex detects your terminal background and defaults to `dark` or `light`.

## Creating a Custom Theme

1. Create a theme file:

```bash
mkdir -p ~/.diffex/agent/themes
vim ~/.diffex/agent/themes/my-theme.json
```

2. Define the theme with all required colors (see [Color Tokens](#color-tokens)):

```json
{
  "$schema": "https://raw.githubusercontent.com/diffexai/diffex/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "primary": "#00aaff",
    "secondary": 242,
    "green": "#00ff00"
  },
  "colors": {
    "accent": "primary",
    "border": "primary",
    "borderAccent": "#00ffff",
    "borderMuted": "secondary",
    "success": "#00ff00",
    "error": "#ff0000",
    "warning": "#ffff00",
    "muted": "secondary",
    "dim": 240,
    "text": "",
    "thinkingText": "secondary",
    "startupIntroText": "#CDD6F4",
    "startupIntroAccent": "#89B4FA",
    "selectionAccent": "#89B4FA",
    "selectedBg": "#2d2d30",
    "scrollbarThumb": "#555566",
    "userMessageBg": "#2d2d30",
    "userMessageText": "",
    "customMessageBg": "#2d2d30",
    "customMessageText": "",
    "customMessageLabel": "primary",
    "toolPendingBg": "#1e1e2e",
    "toolSuccessBg": "#1e2e1e",
    "toolErrorBg": "#2e1e1e",
    "toolTitle": "primary",
    "toolOutput": "",
    "mdHeading": "#ffaa00",
    "mdLink": "primary",
    "mdLinkUrl": "secondary",
    "mdCode": "#00ffff",
    "mdCodeBlock": "",
    "mdCodeBlockBorder": "secondary",
    "mdQuote": "secondary",
    "mdQuoteBorder": "secondary",
    "mdHr": "secondary",
    "mdListBullet": "#00ffff",
    "toolDiffAdded": "#00ff00",
    "toolDiffRemoved": "#ff0000",
    "toolDiffContext": "secondary",
    "syntaxComment": "secondary",
    "syntaxKeyword": "primary",
    "syntaxFunction": "#00aaff",
    "syntaxVariable": "#ffaa00",
    "syntaxString": "#00ff00",
    "syntaxNumber": "#ff00ff",
    "syntaxType": "#00aaff",
    "syntaxOperator": "primary",
    "syntaxPunctuation": "secondary",
    "thinkingOff": "secondary",
    "thinkingMinimal": "primary",
    "thinkingLow": "#00aaff",
    "thinkingMedium": "#00ffff",
    "thinkingHigh": "#ff00ff",
    "thinkingXhigh": "#ff0000",
    "thinkingMax": "#ff0088",
    "bashMode": "#ffaa00",
    "planMode": "green"
  }
}
```

3. Select the theme via `/settings`.

**Hot reload:** When you edit the currently active custom theme file, Diffex reloads it automatically for immediate visual feedback.

## Theme Format

```json
{
  "$schema": "https://raw.githubusercontent.com/diffexai/diffex/main/packages/coding-agent/src/modes/interactive/theme/theme-schema.json",
  "name": "my-theme",
  "vars": {
    "blue": "#0066cc",
    "gray": 242
  },
  "colors": {
    "accent": "blue",
    "muted": "gray",
    "text": "",
    ...
  }
}
```

- `name` is required, must be unique, and must not contain `/`.
- `vars` is optional. Define reusable colors here, then reference them in `colors`.
- `colors` must define all 51 required tokens.
  `planMode`, `thinkingMax`, `scrollbarThumb`, `startupIntroText`, `startupIntroAccent`, `selectionAccent`, and `autocompleteSelected` are optional compatibility tokens with fallbacks.

The `$schema` field enables editor auto-completion and validation.

## Color Tokens

Every theme must define all 51 required color tokens.
`planMode`, `thinkingMax`, `scrollbarThumb`, `startupIntroText`, `startupIntroAccent`, `selectionAccent`, and `autocompleteSelected` are optional for compatibility with existing themes.
When omitted, `planMode` uses `toolDiffAdded`; the remaining tokens use `thinkingXhigh`, `selectedBg`, `text`, `mdLink`, `autocompleteSelected` or `startupIntroAccent`, and `selectionAccent`, respectively.

### Core UI (11 colors)

| Token | Purpose |
|-------|---------|
| `accent` | Primary accent for titles, active controls, and status elements |
| `border` | Normal borders |
| `borderAccent` | Highlighted borders |
| `borderMuted` | Subtle borders (editor) |
| `success` | Success states |
| `error` | Error states |
| `warning` | Warning states |
| `muted` | Secondary text |
| `dim` | Tertiary text |
| `text` | Default text (usually `""`) |
| `thinkingText` | Thinking block text |

### Startup Intro And Selection (4 optional)

| Token | Purpose |
|-------|---------|
| `startupIntroText` | Startup logo art, version, directory, and changelog preview text; optional, falls back to `text` |
| `startupIntroAccent` | Startup title and boundary box; optional, falls back to `mdLink` |
| `selectionAccent` | Selected row prefix and primary text; optional, falls back to `autocompleteSelected`, then `startupIntroAccent` |
| `autocompleteSelected` | Legacy autocomplete selection color; optional, falls back to `selectionAccent` |

### Backgrounds & Content (11 required, 1 optional)

| Token | Purpose |
|-------|---------|
| `selectedBg` | Selected line background |
| `scrollbarThumb` | Fullscreen scrollbar thumb background; optional, falls back to `selectedBg` |
| `userMessageBg` | User message background |
| `userMessageText` | User message text |
| `customMessageBg` | Extension message background |
| `customMessageText` | Extension message text |
| `customMessageLabel` | Extension message label |
| `toolPendingBg` | Tool box (pending) |
| `toolSuccessBg` | Tool box (success) |
| `toolErrorBg` | Tool box (error) |
| `toolTitle` | Tool title |
| `toolOutput` | Tool output text |

### Markdown (10 colors)

| Token | Purpose |
|-------|---------|
| `mdHeading` | Headings |
| `mdLink` | Link text |
| `mdLinkUrl` | Link URL |
| `mdCode` | Inline code |
| `mdCodeBlock` | Code block content |
| `mdCodeBlockBorder` | Code block fences |
| `mdQuote` | Blockquote text |
| `mdQuoteBorder` | Blockquote border |
| `mdHr` | Horizontal rule |
| `mdListBullet` | List bullets |

### Tool Diffs (3 colors)

| Token | Purpose |
|-------|---------|
| `toolDiffAdded` | Added lines |
| `toolDiffRemoved` | Removed lines |
| `toolDiffContext` | Context lines |

### Syntax Highlighting (9 colors)

| Token | Purpose |
|-------|---------|
| `syntaxComment` | Comments |
| `syntaxKeyword` | Keywords |
| `syntaxFunction` | Function names |
| `syntaxVariable` | Variables |
| `syntaxString` | Strings |
| `syntaxNumber` | Numbers |
| `syntaxType` | Types |
| `syntaxOperator` | Operators |
| `syntaxPunctuation` | Punctuation |

### Thinking Level Colors (6 required, 1 optional)

Legacy thinking-level colors exposed through the theme API for extensions. The built-in editor no longer changes its border by thinking effort:

| Token | Purpose |
|-------|---------|
| `thinkingOff` | Thinking off |
| `thinkingMinimal` | Minimal thinking |
| `thinkingLow` | Low thinking |
| `thinkingMedium` | Medium thinking |
| `thinkingHigh` | High thinking |
| `thinkingXhigh` | Extra high thinking |
| `thinkingMax` | Maximum thinking; optional, falls back to `thinkingXhigh` |

### Mode Borders (1 required, 1 optional)

| Token | Purpose |
|-------|---------|
| `bashMode` | Editor border in bash mode (`!` prefix) |
| `planMode` | Editor border and prompt pointer in plan mode; optional, falls back to `toolDiffAdded` |

### HTML Export (optional)

The `export` section controls colors for `/export` HTML output. If omitted, colors are derived from `userMessageBg`.

```json
{
  "export": {
    "pageBg": "#18181e",
    "cardBg": "#1e1e24",
    "infoBg": "#3c3728"
  }
}
```

## Color Values

Four formats are supported:

| Format | Example | Description |
|--------|---------|-------------|
| Hex | `"#ff0000"` | 6-digit hex RGB |
| 256-color | `39` | xterm 256-color palette index (0-255) |
| Variable | `"primary"` | Reference to a `vars` entry |
| Default | `""` | Terminal's default color |

### 256-Color Palette

- `0-15`: Basic ANSI colors (terminal-dependent)
- `16-231`: 6×6×6 RGB cube (`16 + 36×R + 6×G + B` where R,G,B are 0-5)
- `232-255`: Grayscale ramp

### Terminal Compatibility

Diffex uses 24-bit RGB colors. Most modern terminals support this (iTerm2, Kitty, WezTerm, Windows Terminal, VS Code). For older terminals with only 256-color support, Diffex falls back to the nearest approximation.

Check truecolor support:

```bash
echo $COLORTERM  # Should output "truecolor" or "24bit"
```

## Tips

**Dark terminals:** Use bright, saturated colors with higher contrast.

**Light terminals:** Use darker, muted colors with lower contrast.

**Color harmony:** Start with a base palette (Nord, Gruvbox, Tokyo Night), define it in `vars`, and reference consistently.

**Testing:** Check your theme with different message types, tool states, markdown content, and long wrapped text.

**VS Code:** Set `terminal.integrated.minimumContrastRatio` to `1` for accurate colors.

## Examples

See the built-in themes:
- [dark.json](../src/modes/interactive/theme/dark.json)
- [light.json](../src/modes/interactive/theme/light.json)
