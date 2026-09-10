import {
	Container,
	type SelectItem,
	SelectList,
	type SelectListLayoutOptions,
	Spacer,
	Text,
} from "@diffexai/diffex-tui";
import { getSelectListTheme, theme } from "../theme/theme.ts";

const SHOW_IMAGES_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
	minPrimaryColumnWidth: 12,
	maxPrimaryColumnWidth: 32,
};

/**
 * Component that renders the inline image preference.
 */
export class ShowImagesSelectorComponent extends Container {
	private selectList: SelectList;

	constructor(currentValue: boolean, onSelect: (show: boolean) => void, onCancel: () => void) {
		super();

		const items: SelectItem[] = [
			{ value: "yes", label: "Yes", description: "Show images inline in terminal" },
			{ value: "no", label: "No", description: "Show text placeholder instead" },
		];

		this.addChild(new Text(theme.fg("accent", theme.bold("Inline images")), 1, 0));
		this.addChild(new Spacer(1));

		// Create selector
		this.selectList = new SelectList(items, 5, getSelectListTheme(), SHOW_IMAGES_SELECT_LIST_LAYOUT);

		// Preselect current value
		this.selectList.setSelectedIndex(currentValue ? 0 : 1);

		this.selectList.onSelect = (item) => {
			onSelect(item.value === "yes");
		};

		this.selectList.onCancel = () => {
			onCancel();
		};

		this.addChild(this.selectList);
	}

	getSelectList(): SelectList {
		return this.selectList;
	}
}
