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
	surface: false,
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
			.setName("Default mode")
			.setDesc("How the graph opens. You can also switch from the graph toolbar.")
			.addDropdown((d) =>
				d
					.addOptions({ "3d": "3D (orbit)", "2d": "2D (flat view)" })
					.setValue(s.mode)
					.onChange((v) => {
						s.mode = v as RenderOptions["mode"];
						void save();
					}),
			);

		new Setting(containerEl)
			.setName("Group regions by")
			.setDesc("Each group becomes a region of the cortex. Links uses community detection.")
			.addDropdown((d) =>
				d
					.addOptions({ links: "Links (communities)", folder: "Top-level folder" })
					.setValue(s.groupBy)
					.onChange((v) => {
						s.groupBy = v as GroupBy;
						void save("fresh");
					}),
			);

		new Setting(containerEl)
			.setName("Show orphan notes")
			.setDesc("Notes without links sit in the cerebellum.")
			.addToggle((t) =>
				t.setValue(s.showOrphans).onChange((v) => {
					s.showOrphans = v;
					void save("keep");
				}),
			);

		new Setting(containerEl)
			.setName("Brain surface")
			.setDesc(
				"On: dark translucent surface with notes on the outside and arched links. Off: transparent point cloud with notes inside the cortex and links diving toward the center.",
			)
			.addToggle((t) =>
				t.setValue(s.surface).onChange((v) => {
					s.surface = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Depth of field")
			.setDesc("Notes and links behind the center of the brain are blurred and dimmed, highlighting what is in front.")
			.addToggle((t) =>
				t.setValue(s.dof).onChange((v) => {
					s.dof = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Show cortex")
			.setDesc("Anatomical outline: main fissures and sulci, lobes, cerebellum and brainstem.")
			.addToggle((t) =>
				t.setValue(s.showCortex).onChange((v) => {
					s.showCortex = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Node glow")
			.setDesc("Soft halo around each note. Minimal cost: only drawn when the view changes.")
			.addToggle((t) =>
				t.setValue(s.glow).onChange((v) => {
					s.glow = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Hover pulses")
			.setDesc("Hovering a note sends signals along its links. Only animates while the pointer is over it.")
			.addToggle((t) =>
				t.setValue(s.hoverPulses).onChange((v) => {
					s.hoverPulses = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Ambient pulses")
			.setDesc(
				"Slow signals travel through the brain all the time. While idle the view redraws at ~30 fps; turn off for zero cost when still.",
			)
			.addToggle((t) =>
				t.setValue(s.ambientPulses).onChange((v) => {
					s.ambientPulses = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Ambient pulse count")
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
			.setName("Idle animation")
			.setDesc(
				"After ~1.5 s without input: a wave of activity, chain reactions between notes, breathing glow, and the interface fades out. Any movement brings it back.",
			)
			.addToggle((t) =>
				t.setValue(s.idleAnimation).onChange((v) => {
					s.idleAnimation = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Idle orbit")
			.setDesc("The camera slowly orbits the brain while idle (3D mode).")
			.addToggle((t) =>
				t.setValue(s.idleOrbit).onChange((v) => {
					s.idleOrbit = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Node size")
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
			.setName("Hub labels")
			.setDesc("Always show the names of the 10 most connected notes.")
			.addToggle((t) =>
				t.setValue(s.hubLabels).onChange((v) => {
					s.hubLabels = v;
					void save();
				}),
			);

		new Setting(containerEl)
			.setName("Recalculate layout")
			.setDesc(
				"Note positions are saved so the brain always opens the same way. Use this to lay everything out again from scratch.",
			)
			.addButton((b) => b.setButtonText("Recalculate").onClick(() => this.plugin.relayout()));
	}
}
