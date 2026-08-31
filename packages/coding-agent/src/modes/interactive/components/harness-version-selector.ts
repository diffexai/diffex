import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	SELECTED_LIST_PREFIX,
	Spacer,
	TruncatedText,
	UNSELECTED_LIST_PREFIX,
} from "@earendil-works/diffex-tui";
import type { EvolutionHarnessVersionInfo } from "#evolution";
import { theme } from "../theme/theme.ts";
import { formatHarnessVersionLabel, sanitizeDisplayText } from "./harness-version-display.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface HarnessVersionSelectorItem {
	version: string;
	base: string | null | undefined;
	memory: string | undefined;
	display: EvolutionHarnessVersionInfo;
	diagnostic?: string;
}

interface HarnessVersionSelectorBundle {
	manifest: {
		version: string;
		base: string | null;
	};
	state: {
		memory: string;
	};
}

interface HarnessVersionSelectorDiagnostic {
	version: string | null;
	message: string;
	manifest?: HarnessVersionSelectorBundle["manifest"] | null;
	state?: HarnessVersionSelectorBundle["state"] | null;
}

export function createHarnessVersionSelectorItems(
	versions: readonly HarnessVersionSelectorBundle[],
	diagnostics: readonly HarnessVersionSelectorDiagnostic[],
	versionInfo: readonly EvolutionHarnessVersionInfo[] = [],
): HarnessVersionSelectorItem[] {
	const infoByVersion = new Map(versionInfo.map((info) => [info.version, info]));
	const items = new Map<string, HarnessVersionSelectorItem>();
	for (const bundle of versions) {
		const info =
			infoByVersion.get(bundle.manifest.version) ??
			(bundle.manifest.base === null
				? {
						version: bundle.manifest.version,
						kind: "default" as const,
						evolvedAt: null,
						evolvedIn: null,
					}
				: undefined);
		if (info === undefined) continue;
		items.set(bundle.manifest.version, {
			version: bundle.manifest.version,
			base: bundle.manifest.base,
			memory: bundle.state.memory,
			display: info,
		});
	}

	for (const diagnostic of diagnostics) {
		if (!diagnostic.version) continue;
		const info = infoByVersion.get(diagnostic.version);
		if (info === undefined && diagnostic.manifest?.base !== null) continue;
		const existing = items.get(diagnostic.version);
		if (existing) {
			existing.diagnostic = existing.diagnostic
				? `${existing.diagnostic}; ${diagnostic.message}`
				: diagnostic.message;
			continue;
		}
		items.set(diagnostic.version, {
			version: diagnostic.version,
			base: diagnostic.manifest?.base,
			memory: diagnostic.state?.memory,
			display: {
				...(info ?? {
					version: diagnostic.version,
					kind: "default" as const,
					evolvedAt: null,
					evolvedIn: null,
				}),
			},
			diagnostic: diagnostic.message,
		});
	}

	return [...items.values()];
}

function sanitizeTerminalText(value: string): string {
	return sanitizeDisplayText(value);
}

function compareVersions(left: HarnessVersionSelectorItem, right: HarnessVersionSelectorItem): number {
	if (left.version < right.version) return -1;
	if (left.version > right.version) return 1;
	return 0;
}

function getMemoryPreview(memory: string | undefined): string {
	if (memory === undefined) return "(EVOLVE.md unavailable)";
	return (
		memory
			.split(/\r?\n/)
			.map((line) => sanitizeTerminalText(line).trim())
			.find(Boolean) ?? "(empty EVOLVE.md)"
	);
}

export function orderHarnessVersions(
	items: readonly HarnessVersionSelectorItem[],
	currentVersion: string | undefined,
): HarnessVersionSelectorItem[] {
	const byVersion = new Map(items.map((item) => [item.version, item]));
	const ordered: HarnessVersionSelectorItem[] = [];
	const seen = new Set<string>();
	let version = currentVersion;

	while (version && !seen.has(version)) {
		const item = byVersion.get(version);
		if (!item) break;
		ordered.push(item);
		seen.add(version);
		version = item.base ?? undefined;
	}

	const remaining = items
		.filter((item) => !seen.has(item.version))
		.sort((a, b) => {
			if (Boolean(a.diagnostic) !== Boolean(b.diagnostic)) return a.diagnostic ? 1 : -1;
			return compareVersions(a, b);
		});
	return [...ordered, ...remaining];
}

export class HarnessVersionSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly allItems: HarnessVersionSelectorItem[];
	private filteredItems: HarnessVersionSelectorItem[];
	private selectedIndex = 0;
	private readonly currentVersion: string | undefined;
	private readonly onSelectCallback: (version: string) => void;
	private readonly onCancelCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(
		items: readonly HarnessVersionSelectorItem[],
		currentVersion: string | undefined,
		onSelect: (version: string) => void,
		onCancel: () => void,
	) {
		super();
		this.allItems = orderHarnessVersions(items, currentVersion);
		this.filteredItems = this.allItems;
		this.currentVersion = currentVersion;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new TruncatedText(theme.fg("accent", theme.bold("Select harness version:")), 1, 0));
		this.addChild(new Spacer(1));

		this.searchInput.onSubmit = () => this.selectCurrentItem();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);

		this.updateList();
	}

	private filterItems(query: string): void {
		this.filteredItems = query
			? fuzzyFilter(this.allItems, query, (item) => `${item.version} ${getMemoryPreview(item.memory)}`)
			: this.allItems;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 10;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? SELECTED_LIST_PREFIX : UNSELECTED_LIST_PREFIX;
			const label = formatHarnessVersionLabel(item.display, this.currentVersion);
			const unavailable = item.diagnostic ? ` - unavailable: ${sanitizeTerminalText(item.diagnostic)}` : "";
			const line = `${prefix}${label}${unavailable}`;
			this.listContainer.addChild(
				new TruncatedText(
					selected
						? theme.fg(item.diagnostic ? "warning" : "selectionAccent", line)
						: theme.fg(item.diagnostic ? "warning" : "text", line),
					1,
					0,
				),
			);
		}

		if (startIndex > 0 || endIndex < this.filteredItems.length) {
			this.listContainer.addChild(
				new TruncatedText(theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredItems.length})`), 1, 0),
			);
		}
		if (this.filteredItems.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "  No matching versions"), 1, 0));
		}
	}

	private selectCurrentItem(): void {
		const item = this.filteredItems[this.selectedIndex];
		if (item && !item.diagnostic) this.onSelectCallback(item.version);
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredItems.length === 0) return;
			this.selectedIndex = Math.min(this.filteredItems.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			this.selectCurrentItem();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterItems(this.searchInput.getValue());
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
