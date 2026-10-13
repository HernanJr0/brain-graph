import {
	AbstractInputSuggest,
	App,
	Modal,
	PluginSettingTab,
	Setting,
	getAllTags,
	requireApiVersion,
	type SettingDefinitionItem,
} from "obsidian";
import type BrainGraphPlugin from "./main";
import type { GroupBy } from "./graph-core";
import type { RenderOptions } from "./renderer";
import type { Appearance } from "./theme";
import {
	PALETTE_NAMES,
	normalizeHex,
	normalizeRuleValue,
	ruleMatches,
	type ColorRule,
	type PaletteId,
	type RegionColor,
} from "./colors";

export interface BrainGraphSettings extends RenderOptions {
	/** Tema do grafo: segue o Obsidian ou fixo em claro/escuro. */
	appearance: Appearance;
	groupBy: GroupBy;
	showOrphans: boolean;
	/** Paleta das regiões. */
	palette: PaletteId;
	/** Cores escolhidas na legenda, identificadas pela pasta, pelas âncoras ou pelas órfãs. */
	regionColors: RegionColor[];
	/** Regras por pasta e tag; a primeira que casa vence. */
	colorRules: ColorRule[];
	/** Propriedade do frontmatter com a cor da nota ("" desativa). */
	colorProperty: string;
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
	settingsVersion: 3,
	appearance: "auto",
	groupBy: "links",
	showOrphans: true,
	palette: "nebula",
	regionColors: [],
	colorRules: [],
	colorProperty: "color",
};

/** O que muda no grafo: nada além do render, só as cores, rebuild mantendo posições ou layout do zero. */
export type Rebuild = false | "colors" | "keep" | "fresh";
type Key = Exclude<keyof BrainGraphSettings, "settingsVersion" | "regionColors" | "colorRules">;

type Control =
	| { type: "toggle" }
	| { type: "dropdown"; options: Record<string, string> }
	| { type: "slider"; min: number; max: number; step: number }
	| { type: "text"; placeholder?: string };

interface Def {
	key: Key;
	name: string;
	desc?: string;
	control: Control;
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
		key: "appearance",
		name: "Appearance",
		desc: "Follow Obsidian switches between light and dark together with your theme.",
		control: { type: "dropdown", options: { auto: "Follow Obsidian", dark: "Dark", light: "Light" } },
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

/** Seção de cores: paleta e propriedade do frontmatter (as regras vêm numa lista à parte). */
const COLOR_DEFS: Def[] = [
	{
		key: "palette",
		name: "Color palette",
		desc: "Colors of the regions, largest region first. Click a region in the graph legend to pick its color.",
		control: { type: "dropdown", options: PALETTE_NAMES },
		rebuild: "colors",
	},
	{
		key: "colorProperty",
		name: "Color property",
		desc: 'A note with this property in its frontmatter (for example color: "#ff8800") gets that color. Leave empty to turn off.',
		control: { type: "text", placeholder: "color" },
		rebuild: "colors",
	},
];

const ALL_DEFS = [...DEFS, ...COLOR_DEFS];

const RELAYOUT_NAME = "Recalculate layout";
const RELAYOUT_DESC =
	"Note positions are saved so the brain always opens the same way. Use this to lay everything out again from scratch.";
const RESET_REGIONS_NAME = "Reset region colors";
const RESET_REGIONS_DESC = "Regions you painted in the legend go back to the palette.";
const RULES_HEADING = "Color rules";
const RULES_DESC =
	"Paint notes by folder or tag, whatever region they are in. The first matching rule wins; drag to reorder.";
const RULES_EMPTY = "No rules yet. Use + to color a folder or a tag.";
/** Prefixo das chaves da cor de cada regra na API declarativa ("rule:0", "rule:1"…). */
const RULE_KEY = "rule:";

export class BrainGraphSettingTab extends PluginSettingTab {
	constructor(
		app: App,
		private readonly plugin: BrainGraphPlugin,
	) {
		super(app, plugin);
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const s = this.plugin.settings;
		const counts = this.ruleCounts();
		const control = (d: Def) => ({
			name: d.name,
			desc: d.desc,
			control: { key: d.key, defaultValue: DEFAULT_SETTINGS[d.key], ...d.control },
		});
		return [
			...(DEFS.map(control) as SettingDefinitionItem[]),
			{
				type: "group",
				heading: "Colors",
				items: [
					...COLOR_DEFS.map(control),
					{
						name: RESET_REGIONS_NAME,
						desc: RESET_REGIONS_DESC,
						visible: () => this.plugin.settings.regionColors.length > 0,
						action: () => void this.resetRegionColors(),
					},
				],
			},
			{
				type: "list",
				heading: RULES_HEADING,
				items: s.colorRules.map((r, k) => ({
					name: ruleLabel(r),
					desc: countLabel(counts[k]),
					control: { key: RULE_KEY + k, type: "color", defaultValue: r.color },
				})),
				emptyState: RULES_EMPTY,
				onReorder: (from, to) => void this.moveRule(from, to),
				onDelete: (k) => void this.deleteRule(k),
				addItem: { name: "Add rule", action: () => this.openRuleModal() },
			},
			{ name: RELAYOUT_NAME, desc: RELAYOUT_DESC, action: () => this.plugin.relayout() },
		] as SettingDefinitionItem[];
	}

	getControlValue(key: string): unknown {
		if (key.startsWith(RULE_KEY)) return this.plugin.settings.colorRules[Number(key.slice(RULE_KEY.length))]?.color;
		return this.plugin.settings[key as Key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		if (key.startsWith(RULE_KEY)) {
			const rule = this.plugin.settings.colorRules[Number(key.slice(RULE_KEY.length))];
			const color = normalizeHex(value);
			if (!rule || !color) return;
			rule.color = color;
			await this.plugin.saveSettings("colors");
			return;
		}
		const def = ALL_DEFS.find((d) => d.key === key);
		if (!def) return;
		(this.plugin.settings as unknown as Record<string, unknown>)[key] = value;
		await this.plugin.saveSettings(def.rebuild ?? false);
	}

	/** Só usado no Obsidian < 1.13 (sem a API declarativa). */
	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		for (const d of DEFS) this.legacyControl(containerEl, d);

		new Setting(containerEl).setName("Colors").setHeading();
		for (const d of COLOR_DEFS) this.legacyControl(containerEl, d);
		if (this.plugin.settings.regionColors.length)
			new Setting(containerEl)
				.setName(RESET_REGIONS_NAME)
				.setDesc(RESET_REGIONS_DESC)
				.addButton((b) => b.setButtonText("Reset").onClick(() => void this.resetRegionColors()));

		new Setting(containerEl)
			.setName(RULES_HEADING)
			.setDesc(RULES_DESC)
			.setHeading()
			.addExtraButton((b) => b.setIcon("plus").setTooltip("Add rule").onClick(() => this.openRuleModal()));
		const rules = this.plugin.settings.colorRules;
		const counts = this.ruleCounts();
		if (!rules.length) containerEl.createEl("p", { cls: "setting-item-description", text: RULES_EMPTY });
		rules.forEach((r, k) => {
			new Setting(containerEl)
				.setName(ruleLabel(r))
				.setDesc(countLabel(counts[k]))
				.addColorPicker((c) => c.setValue(r.color).onChange((v) => void this.setControlValue(RULE_KEY + k, v)))
				.addExtraButton((b) =>
					b.setIcon("arrow-up").setTooltip("Move up").setDisabled(k === 0).onClick(() => void this.moveRule(k, k - 1)),
				)
				.addExtraButton((b) =>
					b
						.setIcon("arrow-down")
						.setTooltip("Move down")
						.setDisabled(k === rules.length - 1)
						.onClick(() => void this.moveRule(k, k + 1)),
				)
				.addExtraButton((b) => b.setIcon("trash").setTooltip("Delete").onClick(() => void this.deleteRule(k)));
		});

		new Setting(containerEl)
			.setName(RELAYOUT_NAME)
			.setDesc(RELAYOUT_DESC)
			.addButton((b) => b.setButtonText("Recalculate").onClick(() => this.plugin.relayout()));
	}

	private legacyControl(containerEl: HTMLElement, d: Def): void {
		const setting = new Setting(containerEl).setName(d.name);
		if (d.desc) setting.setDesc(d.desc);
		const value = this.getControlValue(d.key);
		const set = (v: unknown) => void this.setControlValue(d.key, v);
		const c = d.control;
		if (c.type === "toggle") setting.addToggle((t) => t.setValue(value as boolean).onChange(set));
		else if (c.type === "dropdown")
			setting.addDropdown((dd) => dd.addOptions(c.options).setValue(value as string).onChange(set));
		else if (c.type === "text")
			setting.addText((t) => t.setPlaceholder(c.placeholder ?? "").setValue(value as string).onChange(set));
		else setting.addSlider((sl) => sl.setLimits(c.min, c.max, c.step).setValue(value as number).onChange(set));
	}

	/** Estrutura da lista mudou: a API declarativa precisa de update(), o display() antigo de redesenhar. */
	private refresh(): void {
		if (requireApiVersion("1.13.0")) this.update();
		else this.display();
	}

	/** Quantas notas cada regra pega (sozinha, sem considerar a ordem): a prévia do que ela vai pintar. */
	private ruleCounts(): number[] {
		const rules = this.plugin.settings.colorRules;
		if (!rules.length) return [];
		const notes = this.app.vault.getMarkdownFiles().map((f) => this.plugin.noteInfo(f));
		return rules.map((r) => notes.filter((n) => ruleMatches(r, n.path, n.tags)).length);
	}

	private async moveRule(from: number, to: number): Promise<void> {
		const rules = this.plugin.settings.colorRules;
		if (to < 0 || to >= rules.length || from === to) return;
		const [rule] = rules.splice(from, 1);
		rules.splice(to, 0, rule);
		await this.plugin.saveSettings("colors");
		this.refresh();
	}

	private async deleteRule(k: number): Promise<void> {
		this.plugin.settings.colorRules.splice(k, 1);
		await this.plugin.saveSettings("colors");
		this.refresh();
	}

	private async resetRegionColors(): Promise<void> {
		this.plugin.settings.regionColors = [];
		await this.plugin.saveSettings("colors");
		this.refresh();
	}

	private openRuleModal(): void {
		new RuleModal(this.app, this.plugin, async (rule) => {
			this.plugin.settings.colorRules.push(rule);
			await this.plugin.saveSettings("colors");
			this.refresh();
		}).open();
	}
}

function ruleLabel(r: ColorRule): string {
	const value = normalizeRuleValue(r.kind, r.value);
	return r.kind === "folder" ? `Folder: ${value}` : `Tag: #${value}`;
}

function countLabel(n: number | undefined): string {
	return n === 1 ? "1 note" : `${n ?? 0} notes`;
}

/** Nova regra: tipo, pasta ou tag (com sugestões) e cor. */
class RuleModal extends Modal {
	private kind: ColorRule["kind"] = "folder";
	private value = "";
	private color: string;

	constructor(
		app: App,
		plugin: BrainGraphPlugin,
		private readonly onSubmit: (rule: ColorRule) => Promise<void>,
	) {
		super(app);
		// Cor inicial: a próxima da paleta escura do Nebula, para regras seguidas não saírem iguais.
		const used = new Set(plugin.settings.colorRules.map((r) => r.color));
		this.color = STARTER_COLORS.find((c) => !used.has(c)) ?? STARTER_COLORS[0];
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle("New color rule");
		let input: HTMLInputElement | undefined;
		let suggest: ValueSuggest | undefined;
		new Setting(contentEl).setName("Match notes by").addDropdown((dd) =>
			dd
				.addOptions({ folder: "Folder", tag: "Tag" })
				.setValue(this.kind)
				.onChange((v) => {
					this.kind = v as ColorRule["kind"];
					if (input) input.placeholder = this.kind === "folder" ? "Projects" : "#idea";
					suggest?.setKind(this.kind);
				}),
		);
		new Setting(contentEl)
			.setName("Folder or tag")
			.setDesc("Subfolders and nested tags are included.")
			.addText((t) => {
				input = t.inputEl;
				t.setPlaceholder("Projects").onChange((v) => (this.value = v));
				suggest = new ValueSuggest(this.app, t.inputEl, this.kind, (v) => {
					t.setValue(v);
					this.value = v;
				});
			});
		new Setting(contentEl).setName("Color").addColorPicker((c) => c.setValue(this.color).onChange((v) => (this.color = v)));
		new Setting(contentEl).addButton((b) =>
			b
				.setButtonText("Add rule")
				.setCta()
				.onClick(async () => {
					const value = normalizeRuleValue(this.kind, this.value);
					const color = normalizeHex(this.color);
					if (!value || !color) return;
					this.close();
					await this.onSubmit({ kind: this.kind, value, color });
				}),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

const STARTER_COLORS = ["#f59e0b", "#8b5cf6", "#ec4899", "#3b82f6", "#10b981", "#ef4444", "#06b6d4", "#eab308"];

/** Sugestões de pasta ou tag existentes no vault. */
class ValueSuggest extends AbstractInputSuggest<string> {
	constructor(
		app: App,
		inputEl: HTMLInputElement,
		private kind: ColorRule["kind"],
		private readonly onPick: (value: string) => void,
	) {
		super(app, inputEl);
	}

	setKind(kind: ColorRule["kind"]): void {
		this.kind = kind;
	}

	protected getSuggestions(query: string): string[] {
		const q = query.trim().toLowerCase().replace(/^#/, "");
		const all =
			this.kind === "folder"
				? this.app.vault
						.getAllFolders(false)
						.map((f) => f.path)
						.sort()
				: [...this.tags()].sort();
		return all.filter((v) => v.toLowerCase().replace(/^#/, "").includes(q)).slice(0, 50);
	}

	renderSuggestion(value: string, el: HTMLElement): void {
		el.setText(value);
	}

	selectSuggestion(value: string): void {
		this.onPick(value);
		this.close();
	}

	private tags(): Set<string> {
		const out = new Set<string>();
		for (const file of this.app.vault.getMarkdownFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			for (const tag of (cache && getAllTags(cache)) ?? []) out.add(tag);
		}
		return out;
	}
}
