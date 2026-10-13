import { ItemView, Keymap, Menu, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type BrainGraphPlugin from "./main";
import { buildGraphCore, type GraphCore } from "./graph-core";
import { BrainRenderer, type ColorOverrides, type ViewPreset } from "./renderer";
import type { Rebuild } from "./settings";
import { isForced, resolveTheme, themeKey } from "./theme";
import {
	PALETTE_NAMES,
	matchRegionColors,
	regionKey,
	regionsOf,
	resolveNoteColors,
	type PaletteId,
	type Region,
} from "./colors";

export const VIEW_TYPE_BRAIN = "brain-graph-view";

export class BrainGraphView extends ItemView {
	private renderer?: BrainRenderer;
	private graph?: GraphCore;
	private files: TFile[] = [];
	private statsEl?: HTMLElement;
	private perfEl?: HTMLElement;
	private buttons: Record<string, HTMLElement> = {};
	private searchIndex = new Map<string, number>();
	/** Renomeações desde o último rebuild (caminho antigo -> novo), para a nota manter a posição. */
	private readonly renames = new Map<string, string>();
	private savedCount = 0;
	/** Tema aplicado (tipo + fundo + paleta), para não repintar a cada css-change sem mudança real. */
	private themeKey = "";
	private regions: Region[] = [];
	/** Para cada cor salva da legenda, a região em que ela caiu no último rebuild (null = não encontrada). */
	private regionFound: (number | null)[] = [];
	private legendEl?: HTMLElement;
	private legendOpen = false;

	private readonly scheduleRebuild = debounce(() => this.rebuild(false), 1500, true);

	constructor(leaf: WorkspaceLeaf, private readonly plugin: BrainGraphPlugin) {
		super(leaf);
	}

	getViewType(): string {
		return VIEW_TYPE_BRAIN;
	}

	getDisplayText(): string {
		return "Brain Graph";
	}

	getIcon(): string {
		return "brain";
	}

	async onOpen(): Promise<void> {
		const root = this.contentEl;
		root.empty();
		root.addClass("brain-graph-container");
		const stage = root.createDiv({ cls: "brain-graph-stage" });
		this.buildToolbar(root);

		const theme = resolveTheme(this.plugin.settings.appearance, root, this.plugin.settings.palette);
		this.themeKey = themeKey(theme);
		root.toggleClass("is-light", theme.kind === "light");
		root.toggleClass("is-forced", isForced(this.plugin.settings.appearance, root));
		this.renderer = new BrainRenderer(stage, { ...this.plugin.settings }, {
			onNodeClick: (i, evt) => void this.openNode(i, evt),
			onNodeContextMenu: (i, evt) => this.nodeMenu(i, evt),
			onRestChange: (resting) => root.toggleClass("is-resting", resting),
			onLayoutSettled: (moved) => {
				// Salva quando algo mudou (layout novo, notas novas ou removidas).
				if (moved || this.graph?.ids.length !== this.savedCount) this.saveLayout();
			},
			onStats: (st) => {
				const ok = st.fps >= 20 ? "" : " ⚠";
				this.perfEl?.setText(
					`${st.fps.toFixed(0)} fps${ok} · worst ${st.worstGapMs.toFixed(0)} ms · cpu ${st.cpuMs.toFixed(1)} ms · ${st.bufferWidth}×${st.bufferHeight}`,
				);
			},
		}, theme);
		// Mexer na barra, digitar ou usar o teclado também tira da tela de descanso.
		const wake = () => this.renderer?.wake();
		this.registerDomEvent(root, "pointermove", wake);
		this.registerDomEvent(root, "keydown", wake);
		this.registerDomEvent(root, "focusin", wake);

		const saved = await this.plugin.loadLayout();
		this.savedCount = saved?.size ?? 0;
		this.rebuild(false, saved);

		this.registerEvent(this.app.metadataCache.on("resolved", () => this.scheduleRebuild()));
		this.registerEvent(this.app.vault.on("delete", () => this.scheduleRebuild()));
		this.registerEvent(
			this.app.vault.on("rename", (file, oldPath) => {
				this.renames.set(oldPath, file.path);
				this.scheduleRebuild();
			}),
		);
		this.registerEvent(this.app.workspace.on("file-open", () => this.syncActive()));
		// Troca de tema (claro/escuro) ou de cores do tema do Obsidian.
		this.registerEvent(this.app.workspace.on("css-change", () => this.applyTheme()));
	}

	async onClose(): Promise<void> {
		this.scheduleRebuild.cancel();
		this.saveLayout.run();
		this.renderer?.dispose();
		this.renderer = undefined;
	}

	onResize(): void {
		this.renderer?.resize();
	}

	/** Chamado pelo plugin quando as configurações mudam. */
	applySettings(rebuild: Rebuild): void {
		this.renderer?.setOptions({ ...this.plugin.settings });
		this.applyTheme();
		this.refreshButtons();
		if (rebuild === "colors") this.recolor();
		else if (rebuild) this.rebuild(rebuild === "fresh");
	}

	/**
	 * @param fresh refaz o layout do zero (ignora posições atuais e salvas).
	 * @param saved posições vindas do layout.json (na abertura da view).
	 */
	rebuild(fresh: boolean, saved?: Map<string, number[]>): void {
		if (!this.renderer) return;
		const s = this.plugin.settings;
		const all = this.app.vault.getMarkdownFiles();
		let prev: Map<string, number[]> | undefined;
		if (!fresh) {
			prev = saved ?? this.renderer.positionsById();
			for (const [from, to] of this.renames) {
				const p = prev.get(from);
				if (p) prev.set(to, p);
			}
		}
		this.renames.clear();
		const graph = buildGraphCore(
			all.map((f) => f.path),
			this.app.metadataCache.resolvedLinks,
			{ groupBy: s.groupBy, includeOrphans: s.showOrphans },
		);
		this.graph = graph;
		this.files = graph.source.map((i) => all[i]);
		this.searchIndex = new Map(graph.names.map((name, i) => [name.toLowerCase(), i]));
		this.regions = regionsOf(graph, s.groupBy);
		this.renderer.setGraph(graph, prev, this.colorOverrides());
		this.syncActive();
		this.renderLegend();
		const links = graph.edges.length / 2;
		this.statsEl?.setText(`${graph.ids.length} notes · ${links} links · ${graph.groupCount} regions`);
	}

	/** Recolore sem refazer o grafo (paleta, regras, propriedade ou cores da legenda mudaram). */
	recolor(): void {
		if (!this.renderer || !this.graph) return;
		this.renderer.setColorOverrides(this.colorOverrides());
		this.renderLegend();
	}

	/** Cores do usuário para o grafo atual: regiões pintadas na legenda e notas (regras, frontmatter). */
	private colorOverrides(): ColorOverrides {
		const s = this.plugin.settings;
		const g = this.graph!;
		const match = matchRegionColors(g, this.regions, s.regionColors, s.groupBy);
		this.regionFound = match.found;
		const notes = s.colorRules.length || s.colorProperty.trim() ? this.files.map((f) => this.plugin.noteInfo(f)) : [];
		return { regions: match.byGroup, nodes: resolveNoteColors(notes, s.colorRules) };
	}

	private readonly saveLayout = debounce(
		() => {
			if (!this.renderer) return;
			const positions = this.renderer.positionsById();
			this.savedCount = positions.size;
			void this.plugin.saveLayout(positions);
		},
		1000,
		true,
	);

	private applyTheme(): void {
		if (!this.renderer) return;
		const { appearance, palette } = this.plugin.settings;
		const theme = resolveTheme(appearance, this.contentEl, palette);
		this.contentEl.toggleClass("is-forced", isForced(appearance, this.contentEl));
		const key = themeKey(theme);
		if (key === this.themeKey) return;
		this.themeKey = key;
		this.contentEl.toggleClass("is-light", theme.kind === "light");
		this.renderer.setTheme(theme);
		this.renderLegend();
	}

	// ---------- Legenda de regiões ----------

	/** Regiões listadas na legenda; as menores ficam de fora (a região pedida pelo menu entra sempre). */
	private static readonly LEGEND_MAX = 40;

	private toggleLegend(open = !this.legendOpen): void {
		this.legendOpen = open;
		this.buttons.legend?.toggleClass("is-active", open);
		this.legendEl?.toggleClass("is-hidden", !open);
		if (!open) this.renderer?.setHighlight([]);
		this.renderLegend();
	}

	/** Redesenha a legenda (se aberta). @returns o seletor de cor de `focusGroup`, se pedido. */
	private renderLegend(focusGroup?: number): HTMLInputElement | undefined {
		const el = this.legendEl;
		const renderer = this.renderer;
		if (!el || !renderer || !this.legendOpen) return undefined;
		el.empty();
		const s = this.plugin.settings;

		const head = el.createDiv({ cls: "brain-graph-legend-head" });
		head.createSpan({ cls: "brain-graph-legend-title", text: "Regions" });
		const select = head.createEl("select", { cls: "dropdown brain-graph-legend-palette", attr: { "aria-label": "Color palette" } });
		for (const [id, name] of Object.entries(PALETTE_NAMES)) select.createEl("option", { value: id, text: name });
		select.value = s.palette;
		select.addEventListener("change", () => {
			s.palette = select.value as PaletteId;
			void this.plugin.saveSettings("colors");
		});

		const custom = new Set(this.regionFound.filter((g): g is number => g !== null));
		const linked = this.regions.filter((r) => r.group >= 0);
		const shown = linked.slice(0, BrainGraphView.LEGEND_MAX);
		if (focusGroup !== undefined && focusGroup >= 0 && !shown.some((r) => r.group === focusGroup))
			shown.push(...linked.filter((r) => r.group === focusGroup));
		const orphans = this.regions.find((r) => r.group < 0);
		if (orphans) shown.push(orphans);

		const list = el.createDiv({ cls: "brain-graph-legend-list" });
		list.addEventListener("mouseleave", () => renderer.setHighlight([]));
		let focusInput: HTMLInputElement | undefined;
		for (const region of shown) {
			const row = list.createDiv({ cls: "brain-graph-legend-row" });
			row.addEventListener("mouseenter", () => renderer.setHighlight(region.members));
			const input = row.createEl("input", {
				cls: "brain-graph-legend-swatch",
				attr: { type: "color", "aria-label": `Color of ${region.name}` },
			});
			input.value = renderer.regionSwatch(region.group);
			// Ao vivo enquanto o seletor é arrastado; grava ao confirmar.
			input.addEventListener("input", () => this.paintRegion(region, input.value, false));
			input.addEventListener("change", () => this.paintRegion(region, input.value, true));
			row.createSpan({ cls: "brain-graph-legend-name", text: region.name, attr: { title: region.name } });
			row.createSpan({ cls: "brain-graph-legend-count", text: String(region.members.length) });
			if (custom.has(region.group)) {
				const reset = row.createEl("button", {
					cls: "clickable-icon brain-graph-legend-reset",
					attr: { "aria-label": "Back to the palette color" },
				});
				setIcon(reset, "rotate-ccw");
				reset.addEventListener("click", () => this.resetRegion(region));
			}
			if (region.group === focusGroup) focusInput = input;
		}
		const hidden = linked.length - shown.filter((r) => r.group >= 0).length;
		if (hidden > 0) list.createDiv({ cls: "brain-graph-legend-more", text: `+${hidden} smaller regions` });
		const lost = this.regionFound.filter((g) => g === null).length;
		if (lost > 0)
			el.createDiv({
				cls: "brain-graph-legend-more",
				text: `${lost} painted ${lost === 1 ? "region was" : "regions were"} not found (reset in settings)`,
			});
		return focusInput;
	}

	/** Pinta uma região: substitui a cor que já caía nela. `persist` = grava (fim da escolha). */
	private paintRegion(region: Region, hex: string, persist: boolean): void {
		const s = this.plugin.settings;
		s.regionColors = s.regionColors.filter((_, k) => this.regionFound[k] !== region.group);
		s.regionColors.push(regionKey(region, hex));
		if (persist) void this.plugin.saveSettings("colors");
		else this.renderer?.setColorOverrides(this.colorOverrides());
	}

	private resetRegion(region: Region): void {
		const s = this.plugin.settings;
		s.regionColors = s.regionColors.filter((_, k) => this.regionFound[k] !== region.group);
		void this.plugin.saveSettings("colors");
	}

	private nodeMenu(i: number, evt: MouseEvent): void {
		const group = this.graph?.group[i];
		if (group === undefined) return;
		const menu = new Menu();
		menu.addItem((item) =>
			item
				.setTitle("Color this region…")
				.setIcon("palette")
				.onClick(() => {
					this.toggleLegend(true);
					const input = this.renderLegend(group);
					if (!input) return;
					input.scrollIntoView({ block: "nearest" });
					// O clique no menu conta como gesto do usuário: o seletor nativo pode abrir.
					try {
						input.showPicker();
					} catch {
						input.click();
					}
				}),
		);
		const file = this.files[i];
		if (file)
			menu.addItem((item) =>
				item
					.setTitle("Open in new tab")
					.setIcon("file-plus")
					.onClick(() => void this.app.workspace.getLeaf("tab").openFile(file)),
			);
		menu.showAtMouseEvent(evt);
	}

	private syncActive(): void {
		const file = this.app.workspace.getActiveFile();
		const idx = file && this.graph ? this.graph.ids.indexOf(file.path) : -1;
		this.renderer?.setActive(idx);
	}

	private async openNode(i: number, evt: MouseEvent): Promise<void> {
		const file = this.files[i];
		if (!file) return;
		await this.app.workspace.getLeaf(Keymap.isModEvent(evt)).openFile(file);
	}

	private buildToolbar(root: HTMLElement): void {
		const bar = root.createDiv({ cls: "brain-graph-toolbar" });
		const s = this.plugin.settings;

		const mode = bar.createEl("button", { cls: "brain-graph-btn brain-graph-mode" });
		mode.onclick = () => {
			s.mode = s.mode === "3d" ? "2d" : "3d";
			void this.plugin.saveSettings(false);
		};
		this.buttons.mode = mode;

		const presets = bar.createDiv({ cls: "brain-graph-group" });
		const presetLabels: Record<ViewPreset, string> = { lateral: "Side", superior: "Top", frontal: "Front" };
		for (const key of Object.keys(presetLabels) as ViewPreset[]) {
			const b = presets.createEl("button", { cls: "brain-graph-btn", text: presetLabels[key] });
			b.onclick = () => this.renderer?.applyPreset(key);
		}

		const toggle = (key: "showCortex" | "surface" | "dof" | "glow" | "ambientPulses", icon: string, label: string) => {
			const b = bar.createEl("button", { cls: "brain-graph-btn", attr: { "aria-label": label } });
			setIcon(b, icon);
			b.onclick = () => {
				s[key] = !s[key];
				void this.plugin.saveSettings(false);
			};
			this.buttons[key] = b;
		};
		toggle("showCortex", "brain", "Show cortex");
		toggle("surface", "layers", "Brain surface");
		toggle("dof", "aperture", "Depth of field");
		toggle("glow", "sparkles", "Node glow");
		toggle("ambientPulses", "activity", "Ambient pulses");

		const legend = bar.createEl("button", { cls: "brain-graph-btn", attr: { "aria-label": "Region colors" } });
		setIcon(legend, "palette");
		legend.onclick = () => this.toggleLegend();
		this.buttons.legend = legend;

		const search = bar.createEl("input", {
			cls: "brain-graph-search",
			attr: { type: "search", placeholder: "Search notes…", spellcheck: "false" },
		});
		search.addEventListener("input", () => {
			const q = search.value.trim().toLowerCase();
			const hits: number[] = [];
			if (q) for (const [name, i] of this.searchIndex) if (name.includes(q)) hits.push(i);
			this.renderer?.setSearch(hits);
		});
		search.addEventListener("keydown", (evt) => {
			if (evt.key === "Escape") {
				search.value = "";
				this.renderer?.setSearch([]);
			}
		});

		this.statsEl = bar.createDiv({ cls: "brain-graph-stats" });
		this.legendEl = root.createDiv({ cls: "brain-graph-legend is-hidden" });
		this.perfEl = root.createDiv({ cls: "brain-graph-perf", text: "rotate the camera to measure fps" });
		this.refreshButtons();
	}

	private refreshButtons(): void {
		const s = this.plugin.settings;
		this.buttons.mode?.setText(s.mode === "3d" ? "3D" : "2D");
		this.buttons.mode?.setAttr("aria-label", s.mode === "3d" ? "Switch to 2D" : "Switch to 3D");
		this.buttons.showCortex?.toggleClass("is-active", s.showCortex);
		this.buttons.surface?.toggleClass("is-active", s.surface);
		this.buttons.dof?.toggleClass("is-active", s.dof);
		this.buttons.glow?.toggleClass("is-active", s.glow);
		this.buttons.ambientPulses?.toggleClass("is-active", s.ambientPulses);
	}
}
