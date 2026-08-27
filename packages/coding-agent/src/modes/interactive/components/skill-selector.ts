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
import type { SkillReference, SkillReferenceGroup } from "../../../core/skills.ts";
import { theme } from "../theme/theme.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

const GROUP_ORDER = ["evolved-workspace", "installed-workspace", "installed-global"] as const;

const GROUP_LABELS: Record<SkillReferenceGroup, string> = {
	"evolved-workspace": "Evolved Workspace Skills",
	"installed-workspace": "Installed Workspace Skills",
	"installed-global": "Installed Global Skills",
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
	private filteredReferences: SkillReference[];
	private readonly selectedKeys = new Set<string>();
	private selectedIndex = 0;
	private readonly onSelectCallback: (references: SkillReference[]) => void;
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
		references: readonly SkillReference[],
		onSelect: (references: SkillReference[]) => void,
		onCancel: () => void,
	) {
		super();
		this.allReferences = orderReferences(references);
		this.filteredReferences = this.allReferences;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));
		this.addChild(new TruncatedText(theme.fg("accent", theme.bold("Reference skills:")), 1, 0));
		this.addChild(new TruncatedText(theme.fg("muted", "Selected skills will be inserted into the editor."), 1, 0));
		this.addChild(new Spacer(1));
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new TruncatedText(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("app.skills.toggle", "toggle") +
					"  " +
					keyHint("tui.select.confirm", "insert") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());
		this.updateList();
	}

	private filterReferences(query: string): void {
		this.filteredReferences = query
			? fuzzyFilter(
					this.allReferences,
					query,
					(reference) => `${reference.name} ${reference.description} ${GROUP_LABELS[reference.group]}`,
				)
			: this.allReferences;
		this.selectedIndex = query ? 0 : Math.min(this.selectedIndex, Math.max(0, this.filteredReferences.length - 1));
		this.updateList();
	}

	private toggleCurrent(): void {
		const current = this.filteredReferences[this.selectedIndex];
		if (!current) return;
		const key = referenceKey(current);
		if (this.selectedKeys.has(key)) this.selectedKeys.delete(key);
		else this.selectedKeys.add(key);
		this.updateList();
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

	private updateList(): void {
		this.listContainer.clear();
		const maxVisible = 5;
		const startIndex = Math.max(
			0,
			Math.min(this.selectedIndex - Math.floor(maxVisible / 2), this.filteredReferences.length - maxVisible),
		);
		const endIndex = Math.min(startIndex + maxVisible, this.filteredReferences.length);

		let renderedGroup: SkillReferenceGroup | undefined;
		for (let index = startIndex; index < endIndex; index += 1) {
			const reference = this.filteredReferences[index];
			if (!reference) continue;
			if (reference.group !== renderedGroup) {
				renderedGroup = reference.group;
				this.listContainer.addChild(
					new TruncatedText(theme.fg("accent", theme.bold(`  ${GROUP_LABELS[reference.group]}`)), 1, 0),
				);
			}
			const focused = index === this.selectedIndex;
			const prefix = focused ? SELECTED_LIST_PREFIX : UNSELECTED_LIST_PREFIX;
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
		if (keybindings.matches(keyData, "tui.select.up")) {
			if (this.filteredReferences.length === 0) return;
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "tui.select.down")) {
			if (this.filteredReferences.length === 0) return;
			this.selectedIndex = Math.min(this.filteredReferences.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (keybindings.matches(keyData, "app.skills.toggle")) {
			this.toggleCurrent();
		} else if (keybindings.matches(keyData, "tui.select.confirm")) {
			this.applySelection();
		} else if (keybindings.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		} else {
			this.searchInput.handleInput(keyData);
			this.filterReferences(this.searchInput.getValue());
		}
	}

	getSearchInput(): Input {
		return this.searchInput;
	}
}
