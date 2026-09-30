import { App, PluginSettingTab, Setting } from "obsidian";
import type BrainGraphPlugin from "./main";
import type { GroupBy } from "./graph-core";
import type { RenderOptions } from "./renderer";

export interface BrainGraphSettings extends RenderOptions {
	groupBy: GroupBy;
	showOrphans: boolean;
	/** Versão do formato das configurações, para migrar padrões antigos. */
	settingsVersion: number;
}

export const DEFAULT_SETTINGS: BrainGraphSettings = {
	mode: "3d",
	showCortex: true,
	nodeSize: 1,
	hubLabels: true,
	glow: true,
	hoverPulses: true,
	ambientPulses: true,
	ambientCount: 45,
	idleAnimation: true,
	surface: true,
	dof: true,
	idleOrbit: true,
	settingsVersion: 2,
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
		const save = (rebuild: false | "keep" | "fresh" = false) => this.plugin.saveSettings(rebuild);

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
						void save("fresh");
					}),
			);

		new Setting(containerEl)
			.setName("Mostrar notas órfãs")
			.setDesc("Notas sem links ficam no cerebelo.")
			.addToggle((t) =>
				t.setValue(s.showOrphans).onChange((v) => {
					s.showOrphans = v;
					void save("keep");
				}),
			);

		new Setting(containerEl)
			.setName("Superfície do cérebro")
			.setDesc(
				"Ligada: superfície escura semitransparente com as notas por fora e links em arco. Desligada: nuvem de pontos transparente com as notas dentro do córtex e links mergulhando para o centro.",
			)
			.addToggle((t) =>
				t.setValue(s.surface).onChange((v) => {
					s.surface = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Profundidade de campo")
			.setDesc("Notas e links atrás do centro do cérebro ficam desfocados e esmaecidos, destacando o que está na frente.")
			.addToggle((t) =>
				t.setValue(s.dof).onChange((v) => {
					s.dof = v;
					void save();
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
			.setName("Brilho dos nós")
			.setDesc("Halo suave em volta de cada nota. Custo mínimo: só é desenhado quando a tela muda.")
			.addToggle((t) =>
				t.setValue(s.glow).onChange((v) => {
					s.glow = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Pulsos no hover")
			.setDesc("Ao parar o mouse numa nota, sinais correm pelos links dela. Só anima enquanto o mouse está em cima.")
			.addToggle((t) =>
				t.setValue(s.hoverPulses).onChange((v) => {
					s.hoverPulses = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Pulsos ambientes")
			.setDesc(
				"Sinais lentos percorrendo o cérebro o tempo todo. Em repouso a tela é redesenhada a ~30 fps; desligue para custo zero parado.",
			)
			.addToggle((t) =>
				t.setValue(s.ambientPulses).onChange((v) => {
					s.ambientPulses = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Quantidade de pulsos ambientes")
			.addSlider((sl) =>
				sl
					.setLimits(5, 150, 5)
					.setValue(s.ambientCount)
					.setDynamicTooltip()
					.onChange((v) => {
						s.ambientCount = v;
						void save();
					}),
			);

		new Setting(containerEl)
			.setName("Tela de descanso")
			.setDesc(
				"Depois de ~1,5 s sem mexer: onda de atividade, reações em cadeia entre notas, brilho respirando e a interface some. Qualquer movimento volta ao normal.",
			)
			.addToggle((t) =>
				t.setValue(s.idleAnimation).onChange((v) => {
					s.idleAnimation = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Órbita na tela de descanso")
			.setDesc("A câmera gira lentamente em volta do cérebro enquanto ele está em repouso (modo 3D).")
			.addToggle((t) =>
				t.setValue(s.idleOrbit).onChange((v) => {
					s.idleOrbit = v;
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

		new Setting(containerEl)
			.setName("Recalcular layout")
			.setDesc(
				"As posições das notas ficam salvas para o cérebro abrir sempre igual. Use isto para distribuir tudo de novo do zero.",
			)
			.addButton((b) => b.setButtonText("Recalcular").onClick(() => this.plugin.relayout()));
	}
}
