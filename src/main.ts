import { Plugin, normalizePath } from "obsidian";
import { LAYOUT_VERSION } from "./layout";
import { BrainGraphSettingTab, DEFAULT_SETTINGS, type BrainGraphSettings } from "./settings";
import { BrainGraphView, VIEW_TYPE_BRAIN } from "./view";

export default class BrainGraphPlugin extends Plugin {
	settings!: BrainGraphSettings;

	async onload(): Promise<void> {
		const saved = (await this.loadData()) as Partial<BrainGraphSettings> | null;
		this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
		// v2: padrão de pulsos ambientes subiu de 30 para 45 (só migra quem ainda estava no padrão antigo).
		if (saved && (saved.settingsVersion ?? 1) < 2) {
			if (saved.ambientCount === 30) this.settings.ambientCount = 45;
			this.settings.settingsVersion = 2;
			await this.saveData(this.settings);
		}

		this.registerView(VIEW_TYPE_BRAIN, (leaf) => new BrainGraphView(leaf, this));
		this.addRibbonIcon("brain", "Open graph view", () => void this.activateView());

		this.addCommand({
			id: "open",
			name: "Open graph view",
			callback: () => void this.activateView(),
		});
		this.addCommand({
			id: "relayout",
			name: "Recalculate layout",
			callback: () => this.relayout(),
		});
		this.addCommand({
			id: "toggle-mode",
			name: "Toggle 2D/3D",
			callback: () => {
				this.settings.mode = this.settings.mode === "3d" ? "2d" : "3d";
				void this.saveSettings(false);
			},
		});

		this.addSettingTab(new BrainGraphSettingTab(this.app, this));
	}

	/**
	 * @param rebuild "fresh" refaz o layout do zero; "keep" reconstrói mantendo as posições.
	 */
	async saveSettings(rebuild: false | "keep" | "fresh"): Promise<void> {
		await this.saveData(this.settings);
		for (const view of this.views()) view.applySettings(rebuild);
	}

	relayout(): void {
		for (const view of this.views()) view.rebuild(true);
	}

	private views(): BrainGraphView[] {
		return this.app.workspace
			.getLeavesOfType(VIEW_TYPE_BRAIN)
			.map((leaf) => leaf.view)
			.filter((v): v is BrainGraphView => v instanceof BrainGraphView);
	}

	// ---------- Posições salvas (layout.json na pasta do plugin) ----------

	private get layoutPath(): string {
		return normalizePath(`${this.manifest.dir}/layout.json`);
	}

	/** Posições salvas, se forem da mesma versão do layout e do mesmo modo de agrupamento. */
	async loadLayout(): Promise<Map<string, number[]> | undefined> {
		try {
			const adapter = this.app.vault.adapter;
			if (!(await adapter.exists(this.layoutPath))) return undefined;
			const data = JSON.parse(await adapter.read(this.layoutPath)) as LayoutFile;
			if (data.version !== LAYOUT_VERSION || data.groupBy !== this.settings.groupBy) return undefined;
			return new Map(Object.entries(data.positions));
		} catch (err) {
			console.warn("Brain Graph: invalid layout.json, recalculating.", err);
			return undefined;
		}
	}

	async saveLayout(positions: Map<string, number[]>): Promise<void> {
		const round = (v: number) => Math.round(v * 1e4) / 1e4;
		const data: LayoutFile = {
			version: LAYOUT_VERSION,
			groupBy: this.settings.groupBy,
			positions: Object.fromEntries(
				[...positions].map(([id, p]) => [id, [round(p[0]), round(p[1]), round(p[2]), p[3]]]),
			),
		};
		await this.app.vault.adapter.write(this.layoutPath, JSON.stringify(data));
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

interface LayoutFile {
	version: number;
	groupBy: string;
	positions: Record<string, number[]>;
}
