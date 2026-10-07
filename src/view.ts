import { ItemView, Keymap, TFile, WorkspaceLeaf, debounce, setIcon } from "obsidian";
import type BrainGraphPlugin from "./main";
import { buildGraphCore, type GraphCore } from "./graph-core";
import { BrainRenderer, type ViewPreset } from "./renderer";

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

		this.renderer = new BrainRenderer(stage, { ...this.plugin.settings }, {
			onNodeClick: (i, evt) => void this.openNode(i, evt),
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
		});
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
	applySettings(rebuild: false | "keep" | "fresh"): void {
		this.renderer?.setOptions({ ...this.plugin.settings });
		this.refreshButtons();
		if (rebuild) this.rebuild(rebuild === "fresh");
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
		this.renderer.setGraph(graph, prev);
		this.syncActive();
		const links = graph.edges.length / 2;
		this.statsEl?.setText(`${graph.ids.length} notes · ${links} links · ${graph.groupCount} regions`);
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
