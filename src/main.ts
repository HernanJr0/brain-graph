import { Plugin } from "obsidian";
import { BrainGraphSettingTab, DEFAULT_SETTINGS, type BrainGraphSettings } from "./settings";
import { BrainGraphView, VIEW_TYPE_BRAIN } from "./view";

export default class BrainGraphPlugin extends Plugin {
	settings!: BrainGraphSettings;

	async onload(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		this.registerView(VIEW_TYPE_BRAIN, (leaf) => new BrainGraphView(leaf, this));
		this.addRibbonIcon("brain", "Abrir Brain Graph", () => void this.activateView());

		this.addCommand({
			id: "open",
			name: "Abrir Brain Graph",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "toggle-mode",
			name: "Alternar 2D/3D",
			callback: () => {
				this.settings.mode = this.settings.mode === "3d" ? "2d" : "3d";
				void this.saveSettings(false);
			},
		});

		this.addSettingTab(new BrainGraphSettingTab(this.app, this));
	}

	async saveSettings(rebuild: boolean): Promise<void> {
		await this.saveData(this.settings);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_BRAIN)) {
			if (leaf.view instanceof BrainGraphView) leaf.view.applySettings(rebuild);
		}
	}

	private async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf = workspace.getLeavesOfType(VIEW_TYPE_BRAIN)[0];
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_BRAIN, active: true });
		}
		await workspace.revealLeaf(leaf);
	}
}
