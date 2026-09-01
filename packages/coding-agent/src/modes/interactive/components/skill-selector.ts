import {
	Container,
	type Focusable,
	fuzzyFilter,
	getKeybindings,
	Input,
	markActiveRow,
	SELECTED_LIST_PREFIX,
	Spacer,
	TruncatedText,
	UNSELECTED_LIST_PREFIX,
} from "@earendil-works/diffex-tui";
import type { SkillReference, SkillReferenceGroup } from "../../../core/skills.ts";
import { theme } from "../theme/theme.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const GROUP_ORDER = ["installed-workspace", "installed-global", "evolved-workspace"] as const;

const GROUP_LABELS: Record<SkillReferenceGroup, string> = {
	"installed-workspace": "Installed Workspace Skills",
	"installed-global": "Installed Global Skills",
	"evolved-workspace": "Evolved Skills",
};

function referenceKey(reference: SkillReference): string {
	return `${reference.skillId}\0${reference.version}`;
}

function orderReferences(references: readonly SkillReference[]): SkillReference[] {
	return GROUP_ORDER.flatMap((group) => references.filter((reference) => reference.group === group));
}

export class SkillSelectorComponent extends Container implements Focusable {
	private readonly searchInput = new Input();
	private readonly listContainer = new Container();
	private readonly allReferences: SkillReference[];
	private readonly groups: SkillReferenceGroup[];
	private filteredReferences: SkillReference[] = [];
	private readonly selectedKeys = new Set<string>();
	private selectedGroupIndex = 0;
	private selectedIndex = 0;
	private activeGroup: SkillReferenceGroup | undefined;
	private readonly onSelectCallback: (references: SkillReference[]) => void;
	private readonly onCancelCallback: () => void;
	private _focused = false;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value && this.activeGroup !== undefined;
	}

	constructor(
		references: readonly SkillReference[],
		onSelect: (references: SkillReference[]) => void,
		onCancel: () => void,
	) {
		super();
		this.allReferences = orderReferences(references);
		this.groups = [...GROUP_ORDER];
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.rebuild();
	}

	private rebuild(): void {
		this.clear();
		if (this.activeGroup === undefined) this.buildGroupView();
		else this.buildSkillView();
	}

	private buildGroupView(): void {
		this.searchInput.focused = false;
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold("Reference skills:")), 1, 0));
		this.addChild(new TruncatedText(theme.fg("muted", "Choose where the skill is installed."), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.updateGroupList();
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "open") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
	}

	private buildSkillView(): void {
		this.searchInput.focused = this._focused;
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold(GROUP_LABELS[this.activeGroup!])), 1, 0));
		this.addChild(new TruncatedText(theme.fg("muted", "Select a skill to reference in the editor."), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.updateSkillList();
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("app.skills.toggle", "toggle") +
					"  " +
					keyHint("tui.select.confirm", "insert") +
					"  " +
					keyHint("tui.select.cancel", "back"),
				1,
				0,
			),
		);
	}

	private updateGroupList(): void {
		this.listContainer.clear();
		for (let index = 0; index < this.groups.length; index += 1) {
			const group = this.groups[index]!;
			const focused = index === this.selectedGroupIndex;
			const prefix = focused ? markActiveRow(SELECTED_LIST_PREFIX) : UNSELECTED_LIST_PREFIX;
			const label = focused ? theme.fg("selectionAccent", GROUP_LABELS[group]) : GROUP_LABELS[group];
			const references = this.allReferences.filter((reference) => reference.group === group);
			const selectedCount = references.filter((reference) => this.selectedKeys.has(referenceKey(reference))).length;
			const selection = selectedCount > 0 ? theme.fg("success", ` · ${selectedCount} selected`) : "";
			this.listContainer.addChild(new TruncatedText(`${prefix}${label}${selection}`, 1, 0));
			this.listContainer.addChild(
				new TruncatedText(
					theme.fg("muted", `    ${references.length} skill${references.length === 1 ? "" : "s"}`),
					1,
					0,
				),
			);
		}
	}

	private filterReferences(query: string): void {
		const groupReferences = this.allReferences.filter((reference) => reference.group === this.activeGroup);
		this.filteredReferences = query
			? fuzzyFilter(groupReferences, query, (reference) => `${reference.name} ${reference.description}`)
			: groupReferences;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredReferences.length - 1));
		this.updateSkillList();
	}

	private openCurrentGroup(): void {
		const group = this.groups[this.selectedGroupIndex];
		if (!group) return;
		this.activeGroup = group;
		this.selectedIndex = 0;
		this.searchInput.setValue("");
		this.filteredReferences = this.allReferences.filter((reference) => reference.group === group);
		this.rebuild();
	}

	private closeCurrentGroup(): void {
		this.activeGroup = undefined;
		this.rebuild();
	}

	private toggleCurrent(): void {
		const current = this.filteredReferences[this.selectedIndex];
		if (!current) return;
		const key = referenceKey(current);
		if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
		else this.selectedKeys.add(key);
		this.updateSkillList();
	}

	private applySelection(): void {
		const selected = this.allReferences.filter((reference) => this.selectedKeys.has(referenceKey(reference)));
		if (selected.length > 0) {
			this.onSelectCallback(selected);
			return;
		}
		const current = this.filteredReferences[this.selectedIndex];
		if (current) this.onSelectCallback([current]);
	}

	private updateSkillList(): void {
		this.listContainer.clear();
		const maxVisible = 5;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredReferences.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredReferences.length);

		for (let index = startIndex; index < endIndex; index += 1) {
			const reference = this.filteredReferences[index];
			if (!reference) continue;
			const focused = index === this.selectedIndex;
			const prefix = focused ? markActiveRow(SELECTED_LIST_PREFIX) : UNSELECTED_LIST_PREFIX;
			const selected = this.selectedKeys.has(referenceKey(reference));
			const selection = selected ? theme.fg("success", " ✓") : "";
			const name = focused ? theme.fg("selectionAccent", reference.name) : reference.name;
			this.listContainer.addChild(new TruncatedText(`${prefix}${name}${selection}`, 1, 0));
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", `    ${reference.description}`), 1, 0));
		}

		if (startIndex > 0 || endIndex < this.filteredReferences.length) {
			this.listContainer.addChild(
				new TruncatedText(
					theme.fg("muted", `  (${this.selectedIndex + 1}/${this.filteredReferences.length})`),
					1,
					0,
				),
			);
		}
		if (this.filteredReferences.length === 0) {
			this.listContainer.addChild(new TruncatedText(theme.fg("muted", "  No matching skills"), 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const keybindings = getKeybindings();
		if (this.activeGroup === undefined) {
			if (keybindings.matches(keyData, "tui.select.up")) {
				this.selectedGroupIndex = Math.max(0, this.selectedGroupIndex - 1);
				this.updateGroupList();
			} else if (keybindings.matches(keyData, "tui.select.down")) {
				this.selectedGroupIndex = Math.min(this.groups.length - 1, this.selectedGroupIndex + 1);
				this.updateGroupList();
			} else if (keybindings.matches(keyData, "tui.select.confirm")) {
				this.openCurrentGroup();
			} else if (keybindings.matches(keyData, "tui.select.cancel")) {
				this.onCancelCallback();
			}
			return;
		}

		if (keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredReferences.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateSkillList();
		} else if (keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredReferences.length === 0) return;
			this.selectedIndex = Math.min(this.filteredReferences.length - 1, this.selectedIndex + 1);
			this.updateSkillList();
		} else if (keybindings.matches(keyData, "app.skills.toggle")) {
			this.toggleCurrent();
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			this.applySelection();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.closeCurrentGroup();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterReferences(this.searchInput.getValue());
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
