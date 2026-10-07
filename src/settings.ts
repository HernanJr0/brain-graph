import { App, PluginSettingTab, Setting, type SettingDefinitionItem } from "obsidian";
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

type Rebuild = false | "keep" | "fresh";
type Key = Exclude<keyof BrainGraphSettings, "settingsVersion">;

type Control =
	| { type: "toggle" }
	| { type: "dropdown"; options: Record<string, string> }
	| { type: "slider"; min: number; max: number; step: number };

interface Def {
	key: Key;
	name: string;
	desc?: string;
	control: Control;
	/** O que muda no grafo: nada além do render, rebuild mantendo posições ou layout do zero. */
	rebuild?: Rebuild;
}

/** Fonte única das configurações: alimenta a API declarativa (1.13+) e o display() das versões antigas. */
const DEFS: Def[] = [
	{
		key: "mode",
		name: "Default mode",
		desc: "How the graph opens. You can also switch from the graph toolbar.",
		control: { type: "dropdown", options: { "3d": "3D (orbit)", "2d": "2D (flat view)" } },
	},
	{
		key: "groupBy",
		name: "Group regions by",
		desc: "Each group becomes a region of the cortex. Links uses community detection.",
		control: { type: "dropdown", options: { links: "Links (communities)", folder: "Top-level folder" } },
		rebuild: "fresh",
	},
	{
		key: "showOrphans",
		name: "Show orphan notes",
		desc: "Notes without links sit in the cerebellum.",
		control: { type: "toggle" },
		rebuild: "keep",
	},
	{
		key: "surface",
		name: "Brain surface",
		desc: "On: dark translucent surface with notes on the outside and arched links. Off: transparent point cloud with notes inside the cortex and links diving toward the center.",
		control: { type: "toggle" },
	},
	{
		key: "dof",
		name: "Depth of field",
		desc: "Notes and links behind the center of the brain are blurred and dimmed, highlighting what is in front.",
		control: { type: "toggle" },
	},
	{
		key: "showCortex",
		name: "Show cortex",
		desc: "Anatomical outline: main fissures and sulci, lobes, cerebellum and brainstem.",
		control: { type: "toggle" },
	},
	{
		key: "glow",
		name: "Node glow",
		desc: "Soft halo around each note. Minimal cost: only drawn when the view changes.",
		control: { type: "toggle" },
	},
	{
		key: "hoverPulses",
		name: "Hover pulses",
		desc: "Hovering a note sends signals along its links. Only animates while the pointer is over it.",
		control: { type: "toggle" },
	},
	{
		key: "ambientPulses",
		name: "Ambient pulses",
		desc: "Slow signals travel through the brain all the time. While idle the view redraws at ~30 fps; turn off for zero cost when still.",
		control: { type: "toggle" },
	},
	{
		key: "ambientCount",
		name: "Ambient pulse count",
		control: { type: "slider", min: 5, max: 150, step: 5 },
	},
	{
		key: "idleAnimation",
		name: "Idle animation",
		desc: "After ~1.5 s without input: a wave of activity, chain reactions between notes, breathing glow, and the interface fades out. Any movement brings it back.",
		control: { type: "toggle" },
	},
	{
		key: "idleOrbit",
		name: "Idle orbit",
		desc: "The camera slowly orbits the brain while idle (3D mode).",
		control: { type: "toggle" },
	},
	{
		key: "nodeSize",
		name: "Node size",
		control: { type: "slider", min: 0.4, max: 3, step: 0.1 },
	},
	{
		key: "hubLabels",
		name: "Hub labels",
		desc: "Always show the names of the 10 most connected notes.",
		control: { type: "toggle" },
	},
];

const RELAYOUT_NAME = "Recalculate layout";
const RELAYOUT_DESC =
	"Note positions are saved so the brain always opens the same way. Use this to lay everything out again from scratch.";

export class BrainGraphSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: BrainGraphPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			...DEFS.map((d) => ({
				name: d.name,
				desc: d.desc,
				control: { key: d.key, defaultValue: DEFAULT_SETTINGS[d.key], ...d.control },
			})) as SettingDefinitionItem[],
			{ name: RELAYOUT_NAME, desc: RELAYOUT_DESC, action: () => this.plugin.relayout() },
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as Key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const def = DEFS.find((d) => d.key === key);
		if (!def) return;
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings(def.rebuild ?? false);
	}

	/** Só usado no Obsidian < 1.13 (sem a API declarativa). */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const d of DEFS) {
			const setting = new Setting(containerEl).setName(d.name);
			if (d.desc) setting.setDesc(d.desc);
			const value = this.getControlValue(d.key);
			const set = (v: unknown) => void this.setControlValue(d.key, v);
			const c = d.control;
			if (c.type === "toggle") setting.addToggle((t) => t.setValue(value as boolean).onChange(set));
			else if (c.type === "dropdown")
				setting.addDropdown((dd) => dd.addOptions(c.options).setValue(value as string).onChange(set));
			else setting.addSlider((sl) => sl.setLimits(c.min, c.max, c.step).setValue(value as number).onChange(set));
		}
		new Setting(containerEl)
			.setName(RELAYOUT_NAME)
			.setDesc(RELAYOUT_DESC)
			.addButton((b) => b.setButtonText("Recalculate").onClick(() => this.plugin.relayout()));
	}
}
