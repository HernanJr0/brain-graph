import { App, PluginSettingTab, Setting } from "obsidian";
import type BrainGraphPlugin from "./main";
import type { GroupBy } from "./graph-core";
import type { RenderOptions } from "./renderer";

export interface BrainGraphSettings extends RenderOptions {
	groupBy: GroupBy;
	showOrphans: boolean;
}

export const DEFAULT_SETTINGS: BrainGraphSettings = {
	mode: "3d",
	showCortex: true,
	nodeSize: 1,
	hubLabels: true,
	groupBy: "links",
	showOrphans: true,
};

export class BrainGraphSettingTab extends PluginSettingTab {
	constructor(app: App, private readonly plugin: BrainGraphPlugin) {
		super(app, plugin);
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		const s = this.plugin.settings;
		const save = (rebuild = false) => this.plugin.saveSettings(rebuild);

		new Setting(containerEl)
			.setName("Modo padrão")
			.setDesc("Como o grafo abre. Dá para alternar pela barra do próprio grafo.")
			.addDropdown((d) =>
				d
					.addOptions({ "3d": "3D (orbitar)", "2d": "2D (vista plana)" })
					.setValue(s.mode)
					.onChange((v) => {
						s.mode = v as RenderOptions["mode"];
						void save();
					}),
			);

		new Setting(containerEl)
			.setName("Agrupar regiões por")
			.setDesc("Cada grupo vira uma região do córtex. Links usa detecção de comunidades.")
			.addDropdown((d) =>
				d
					.addOptions({ links: "Links (comunidades)", folder: "Pasta de primeiro nível" })
					.setValue(s.groupBy)
					.onChange((v) => {
						s.groupBy = v as GroupBy;
						void save(true);
					}),
			);

		new Setting(containerEl)
			.setName("Mostrar notas órfãs")
			.setDesc("Notas sem links ficam no cerebelo.")
			.addToggle((t) =>
				t.setValue(s.showOrphans).onChange((v) => {
					s.showOrphans = v;
					void save(true);
				}),
			);

		new Setting(containerEl)
			.setName("Mostrar córtex")
			.setDesc("Contorno anatômico: fissuras e sulcos principais, lobos, cerebelo e tronco.")
			.addToggle((t) =>
				t.setValue(s.showCortex).onChange((v) => {
					s.showCortex = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Tamanho dos nós")
			.addSlider((sl) =>
				sl
					.setLimits(0.4, 3, 0.1)
					.setValue(s.nodeSize)
					.setDynamicTooltip()
					.onChange((v) => {
						s.nodeSize = v;
						void save();
					}),
			);

		new Setting(containerEl)
			.setName("Rótulos dos hubs")
			.setDesc("Mostra sempre o nome das 10 notas mais conectadas.")
			.addToggle((t) =>
				t.setValue(s.hubLabels).onChange((v) => {
					s.hubLabels = v;
					void save();
				}),
			);
	}
}
