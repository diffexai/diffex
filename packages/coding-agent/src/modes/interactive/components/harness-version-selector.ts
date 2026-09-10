import { computeHarnessSkillId, type HarnessSkill } from "@diffexai/diffex-harness-state";
import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	markActiveRow,
	SELECTED_LIST_PREFIX,
	Spacer,
	Text,
	TruncatedText,
	UNSELECTED_LIST_PREFIX,
} from "@diffexai/diffex-tui";
import type { EvolutionHarnessVersionInfo } from "#evolution";
import { theme } from "../theme/theme.ts";
import {
	formatHarnessVersionInventory,
	formatHarnessVersionLabel,
	formatHarnessVersionPickerLabel,
	sanitizeDisplayText,
} from "./harness-version-display.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

type SelectorSkill = Pick<
	HarnessSkill,
	"path" | "name" | "description" | "content" | "packageVersion" | "workspace" | "files"
>;

export interface HarnessVersionSelectorItem {
	version: string;
	base: string | null | undefined;
	memory: string | undefined;
	skills: readonly SelectorSkill[] | undefined;
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
		skills: readonly SelectorSkill[];
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
		items.set(bundle.manifest.version, {
			version: bundle.manifest.version,
			base: bundle.manifest.base,
			memory: bundle.state.memory,
			skills: bundle.state.skills,
			display: infoByVersion.get(bundle.manifest.version) ?? {
				version: bundle.manifest.version,
				kind: bundle.manifest.base === null ? "default" : "evolved",
				evolvedAt: null,
				evolvedIn: null,
			},
		});
	}

	for (const diagnostic of diagnostics) {
		if (!diagnostic.version) continue;
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
			skills: diagnostic.state?.skills,
			display: infoByVersion.get(diagnostic.version) ?? {
				version: diagnostic.version,
				kind: diagnostic.manifest?.base === null ? "default" : "evolved",
				evolvedAt: null,
				evolvedIn: null,
			},
			diagnostic: diagnostic.message,
		});
	}

	return [...items.values()];
}

export function orderHarnessVersions(items: readonly HarnessVersionSelectorItem[]): HarnessVersionSelectorItem[] {
	return [...items].sort((a, b) => {
		if ((a.diagnostic !== undefined) !== (b.diagnostic !== undefined)) return a.diagnostic !== undefined ? 1 : -1;
		const aTime = Date.parse(a.display.evolvedAt ?? "");
		const bTime = Date.parse(b.display.evolvedAt ?? "");
		const aKnown = Number.isFinite(aTime);
		const bKnown = Number.isFinite(bTime);
		if (aKnown !== bKnown) return aKnown ? -1 : 1;
		if (aKnown && bKnown && aTime !== bTime) return bTime - aTime;
		return a.version < b.version ? -1 : a.version > b.version ? 1 : 0;
	});
}

export class HarnessVersionSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly warning = new Text("", 1, 0);
	private readonly allItems: HarnessVersionSelectorItem[];
	private filteredItems: HarnessVersionSelectorItem[];
	private selectedIndex = 0;
	private detailOffset = 0;
	private readonly detailPageSize = 8;
	private detailLineCount = 0;
	private pendingVersion: string | undefined;
	private readonly currentVersion: string | undefined;
	private readonly observedSkills: readonly SelectorSkill[];
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
		observedSkills: readonly SelectorSkill[] = [],
	) {
		super();
		this.allItems = orderHarnessVersions(items);
		this.filteredItems = this.allItems;
		this.currentVersion = currentVersion;
		this.observedSkills = observedSkills;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new TruncatedText(theme.fg("accent", theme.bold("Select harness version:")), 1, 0));
		this.searchInput.onSubmit = () => this.selectCurrentItem();
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(this.warning);
		this.addChild({ render: (width) => this.renderDetails(width), invalidate: () => {} });
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.pageUp", "details up") +
					"  " +
					keyHint("tui.select.pageDown", "details down") +
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
			? fuzzyFilter(
					this.allItems,
					query,
					(item) =>
						`${item.version} ${formatHarnessVersionLabel(item.display, this.currentVersion)} ${item.memory ?? ""} ${
							item.skills?.map((skill) => `${skill.name} ${skill.path} ${skill.description}`).join(" ") ?? ""
						}`,
				)
			: this.allItems;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredItems.length - 1));
		this.updateList();
	}

	private skillChanges(item: HarnessVersionSelectorItem): {
		known: boolean;
		removed: SelectorSkill[];
		updated: SelectorSkill[];
	} {
		const current = this.allItems.find((candidate) => candidate.version === this.currentVersion);
		const targetSkills = new Map(
			(item.skills ?? []).map((skill) => [computeHarnessSkillId(skill.workspace, skill.path), skill]),
		);
		const removed = new Map<string, SelectorSkill>();
		const updated = new Map<string, SelectorSkill>();
		for (const skill of [...(current?.skills ?? []), ...this.observedSkills]) {
			const id = computeHarnessSkillId(skill.workspace, skill.path);
			const target = targetSkills.get(id);
			if (!target) removed.set(id, skill);
			else if (target.packageVersion !== skill.packageVersion) updated.set(id, target);
		}
		return {
			known: current?.skills !== undefined && item.skills !== undefined,
			removed: [...removed.values()],
			updated: [...updated.values()],
		};
	}

	private renderDetails(width: number): string[] {
		const item = this.filteredItems[this.selectedIndex];
		if (!item) return [];
		const { known, removed, updated } = this.skillChanges(item);
		const lines = [
			`Version: ${sanitizeDisplayText(item.version)}`,
			formatHarnessVersionInventory(item.memory, item.skills?.length),
			`Activation: ${sanitizeDisplayText(item.display.evolvedAt ?? "unknown")}`,
		];
		if (item.display.origin) lines.push(`Origin: ${item.display.origin} activation`);
		if (item.display.evolvedIn) lines.push(`Evolved in: ${sanitizeDisplayText(item.display.evolvedIn)}`);
		if (item.diagnostic !== undefined) lines.push(`Unavailable: ${sanitizeDisplayText(item.diagnostic)}`);
		if (!known) lines.push("Skill comparison unavailable: selected or target inventory is missing.");
		if (removed.length > 0)
			lines.push(`Skills removed: ${removed.map((skill) => sanitizeDisplayText(skill.name)).join(", ")}`);
		if (updated.length > 0)
			lines.push(`Skills updated: ${updated.map((skill) => sanitizeDisplayText(skill.name)).join(", ")}`);
		lines.push("EVOLVE.md:");
		lines.push(
			...(item.memory === undefined
				? ["(unavailable)"]
				: item.memory.trim() === ""
					? ["(empty)"]
					: item.memory.split(/\r?\n/).map(sanitizeDisplayText)),
		);
		lines.push("Skills (complete bundle inventory):");
		if (item.skills === undefined) lines.push("(unavailable)");
		else if (item.skills.length === 0) lines.push("(none)");
		for (const skill of item.skills ?? []) {
			lines.push(
				sanitizeDisplayText(`${skill.name}: ${skill.description}`),
				sanitizeDisplayText(`  ${skill.path} · ${skill.packageVersion}`),
				sanitizeDisplayText(
					`  Workspace: ${skill.workspace.repositoryId} / ${skill.workspace.directoryId ?? "(repository)"}`,
				),
				...skill.content.split(/\r?\n/).map(sanitizeDisplayText),
				...skill.files.map((file) => sanitizeDisplayText(`  File: ${file.path} · ${file.contentHash}`)),
			);
		}
		const rendered = new Text(lines.join("\n"), 1, 0).render(width);
		this.detailLineCount = rendered.length;
		this.detailOffset = Math.min(this.detailOffset, Math.max(0, rendered.length - this.detailPageSize));
		return [
			...new TruncatedText(
				theme.fg(
					"muted",
					`Bundle details (${this.detailOffset + 1}-${Math.min(this.detailOffset + this.detailPageSize, rendered.length)}/${rendered.length})`,
				),
				1,
				0,
			).render(width),
			...rendered.slice(this.detailOffset, this.detailOffset + this.detailPageSize),
		];
	}

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 4;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredItems.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredItems.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const item = this.filteredItems[index];
			if (!item) continue;
			const selected = index === this.selectedIndex;
			const prefix = selected ? markActiveRow(SELECTED_LIST_PREFIX) : UNSELECTED_LIST_PREFIX;
			const label = formatHarnessVersionPickerLabel(
				item.display,
				this.currentVersion,
				item.memory,
				item.skills?.length,
			);
			const unavailable =
				item.diagnostic !== undefined ? ` - unavailable: ${sanitizeDisplayText(item.diagnostic)}` : "";
			const line = `${prefix}${label}${unavailable}`;
			this.listContainer.addChild(
				new TruncatedText(
					theme.fg(item.diagnostic !== undefined ? "warning" : selected ? "selectionAccent" : "text", line),
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
		const item = this.filteredItems[this.selectedIndex];
		const changes = item && item.diagnostic === undefined ? this.skillChanges(item) : undefined;
		this.warning.setText(
			changes && (!changes.known || changes.removed.length > 0 || changes.updated.length > 0)
				? theme.fg(
						"warning",
						`Warning: skills removed: ${changes.removed.length} · updated: ${changes.updated.length}${
							changes.known ? " (selected/session)" : " · comparison incomplete"
						}\n${
							this.pendingVersion
								? `${keyHint("tui.select.confirm", "confirm changes")} · ${keyHint("tui.select.cancel", "back")}`
								: "Selection requires confirmation; inspect bundle details."
						}`,
					)
				: "",
		);
	}

	private selectCurrentItem(): void {
		const item = this.filteredItems[this.selectedIndex];
		if (!item || item.diagnostic !== undefined) return;
		const changes = this.skillChanges(item);
		if (
			(!changes.known || changes.removed.length > 0 || changes.updated.length > 0) &&
			this.pendingVersion !== item.version
		) {
			this.pendingVersion = item.version;
			this.detailOffset = 0;
			this.updateList();
			return;
		}
		this.onSelectCallback(item.version);
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (keybindings.matches(keyData, "tui.select.pageUp")) {
			this.detailOffset = Math.max(0, this.detailOffset - this.detailPageSize);
		} else if (keybindings.matches(keyData, "tui.select.pageDown")) {
			this.detailOffset = Math.min(
				Math.max(0, this.detailLineCount - this.detailPageSize),
				this.detailOffset + this.detailPageSize,
			);
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			this.selectCurrentItem();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			if (this.pendingVersion) {
				this.pendingVersion = undefined;
				this.updateList();
			} else this.onCancelCallback();
		} else {
			this.pendingVersion = undefined;
			this.detailOffset = 0;
			if (keybindings.matches(keyData, "tui.select.up")) {
				this.selectedIndex = Math.max(0, this.selectedIndex - 1);
				this.updateList();
			} else if (keybindings.matches(keyData, "tui.select.down")) {
				this.selectedIndex = Math.max(0, Math.min(this.filteredItems.length - 1, this.selectedIndex + 1));
				this.updateList();
			} else {
				this.searchInput.handleInput(keyData);
				this.filterItems(this.searchInput.getValue());
			}
		}
	}

	override invalidate(): void {
		super.invalidate();
		this.updateList();
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
