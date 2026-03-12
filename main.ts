import { App, Plugin, PluginSettingTab, Setting, ItemView, WorkspaceLeaf, Notice, TFile } from 'obsidian';
import { Markmap } from 'markmap-view';
import { Transformer } from 'markmap-lib';

// =========================================================================
//  Branch-aware color system
//  • Each top-level branch gets a distinct hue
//  • Deeper nodes keep the same hue but become progressively lighter / softer
// =========================================================================
const BRANCH_HUES = [210, 150, 28, 280, 355, 178, 340, 55, 245, 118];

function branchColor(node: any): string {
    const depth: number = node.state?.depth ?? 0;
    const path: string = node.state?.path ?? '0';

    // Root node — neutral dark
    if (depth === 0) return '#555';

    // Top-level branch index from path (e.g. "0.2.1" → branch 2)
    const segments = path.split('.');
    const branchIdx = segments.length > 1 ? parseInt(segments[1], 10) : 0;
    const hue = BRANCH_HUES[branchIdx % BRANCH_HUES.length];

    // Depth-based gradient: deeper → lighter & softer
    const d = Math.min(depth - 1, 6);
    const sat = Math.max(68 - d * 5, 35);
    const lgt = Math.min(42 + d * 6, 72);

    return `hsl(${hue}, ${sat}%, ${lgt}%)`;
}

// =========================================================================
//  Settings
// =========================================================================
interface MindMapSettings {
    lineWidth: number;
    fontSize: number;
    theme: 'light' | 'dark' | 'auto';
    enableAnimation: boolean;
    showToolbar: boolean;
    maxDepth: number;
    spacingVertical: number;
    spacingHorizontal: number;
    paddingX: number;
}

const DEFAULT_SETTINGS: MindMapSettings = {
    lineWidth: 2,
    fontSize: 14,
    theme: 'auto',
    enableAnimation: true,
    showToolbar: true,
    maxDepth: -1,
    spacingVertical: 10,
    spacingHorizontal: 80,
    paddingX: 8,
};

const VIEW_TYPE_MINDMAP = 'mindmap-view';

// =========================================================================
//  Plugin
// =========================================================================
export default class MindMapPlugin extends Plugin {
    settings: MindMapSettings;
    transformer: Transformer;

    async onload() {
        await this.loadSettings();
        this.transformer = new Transformer();

        this.registerView(VIEW_TYPE_MINDMAP, (leaf) => new MindMapView(leaf, this));

        // Ribbon icon — opens the current active md file as a mindmap
        this.addRibbonIcon('brain', 'Open MindMap', () => {
            const file = this.app.workspace.getActiveFile();
            if (file && file.extension === 'md') {
                this.openMindMap(file);
            } else {
                new Notice('Please open a markdown file first');
            }
        });

        // ---- Commands (all bindable to custom hotkeys) ----

        this.addCommand({
            id: 'open-mindmap',
            name: 'Open as MindMap',
            checkCallback: (checking) => {
                const file = this.app.workspace.getActiveFile();
                if (file?.extension === 'md') {
                    if (!checking) this.openMindMap(file);
                    return true;
                }
                return false;
            },
        });

        this.addCommand({
            id: 'export-mindmap-png',
            name: 'Export MindMap as PNG',
            checkCallback: (checking) => {
                const v = this.app.workspace.getActiveViewOfType(MindMapView);
                if (v) { if (!checking) v.exportAsPNG(); return true; }
                return false;
            },
        });

        this.addCommand({
            id: 'export-mindmap-svg',
            name: 'Export MindMap as SVG',
            checkCallback: (checking) => {
                const v = this.app.workspace.getActiveViewOfType(MindMapView);
                if (v) { if (!checking) v.exportAsSVG(); return true; }
                return false;
            },
        });

        this.addCommand({
            id: 'export-mindmap-html',
            name: 'Export MindMap as HTML',
            checkCallback: (checking) => {
                const v = this.app.workspace.getActiveViewOfType(MindMapView);
                if (v) { if (!checking) v.exportAsHTML(); return true; }
                return false;
            },
        });

        // Settings tab
        this.addSettingTab(new MindMapSettingTab(this.app, this));

        // Right-click context menu on md files
        this.registerEvent(
            this.app.workspace.on('file-menu', (menu, file) => {
                if (file instanceof TFile && file.extension === 'md') {
                    menu.addItem((item) => {
                        item.setTitle('Open as MindMap')
                            .setIcon('brain')
                            .onClick(() => this.openMindMap(file));
                    });
                }
            })
        );
    }

    async openMindMap(file: TFile) {
        // Reuse existing mindmap tab for the same file
        for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MINDMAP)) {
            if (leaf.getViewState().state?.file === file.path) {
                this.app.workspace.revealLeaf(leaf);
                return;
            }
        }
        const leaf = this.app.workspace.getLeaf('tab');
        await leaf.setViewState({ type: VIEW_TYPE_MINDMAP, state: { file: file.path } });
        this.app.workspace.revealLeaf(leaf);
    }

    onunload() {
        this.app.workspace.detachLeavesOfType(VIEW_TYPE_MINDMAP);
    }

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

// =========================================================================
//  MindMap View
// =========================================================================
class MindMapView extends ItemView {
    private plugin: MindMapPlugin;
    private file: TFile | null = null;
    private markmap: Markmap | null = null;
    private svg: SVGSVGElement | null = null;
    private mindmapContent: HTMLElement;
    private toolbar: HTMLElement;

    constructor(leaf: WorkspaceLeaf, plugin: MindMapPlugin) {
        super(leaf);
        this.plugin = plugin;
    }

    getViewType() { return VIEW_TYPE_MINDMAP; }
    getDisplayText() { return this.file ? `MindMap: ${this.file.basename}` : 'MindMap'; }
    getIcon() { return 'brain'; }

    async onOpen() {
        const container = this.containerEl.children[1] as HTMLElement;
        container.empty();
        container.addClass('mindmap-container');

        if (this.plugin.settings.showToolbar) {
            this.createToolbar(container);
        }

        this.mindmapContent = container.createDiv('mindmap-content');

        const state = this.getState() as any;
        if (state?.file) {
            const file = this.app.vault.getAbstractFileByPath(state.file);
            if (file instanceof TFile) await this.loadFile(file);
        }
    }

    // ----------------------------------------------------------------
    //  Toolbar
    // ----------------------------------------------------------------

    private createToolbar(container: HTMLElement) {
        this.toolbar = container.createDiv('mindmap-toolbar');

        this.addBtn('🔄', 'Refresh', () => this.refresh());
        this.addBtn('➕', 'Zoom In', () => this.zoomIn());
        this.addBtn('➖', 'Zoom Out', () => this.zoomOut());
        this.addBtn('🎯', 'Fit View', () => this.fitView());
        this.createExportButton();
    }

    private addBtn(icon: string, title: string, action: () => void) {
        const b = this.toolbar.createEl('button', {
            text: icon,
            attr: { 'aria-label': title, title },
        });
        b.onclick = action;
        return b;
    }

    private createExportButton() {
        const wrapper = this.toolbar.createDiv('mindmap-export-wrapper');
        const btn = wrapper.createEl('button', {
            text: '📤',
            attr: { 'aria-label': 'Export', title: 'Export' },
        });
        btn.addClass('mindmap-export-btn');

        const dropdown = wrapper.createDiv('mindmap-export-dropdown');

        const formats = [
            { label: '💾 PNG', fn: () => this.exportAsPNG() },
            { label: '📄 SVG', fn: () => this.exportAsSVG() },
            { label: '🌐 HTML', fn: () => this.exportAsHTML() },
        ];
        for (const { label, fn } of formats) {
            const item = dropdown.createEl('div', { text: label, cls: 'mindmap-export-item' });
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                wrapper.removeClass('is-active');
                fn();
            });
        }

        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            wrapper.toggleClass('is-active', !wrapper.hasClass('is-active'));
        });

        // Close dropdown on outside click
        this.registerDomEvent(document, 'click', () => wrapper.removeClass('is-active'));
    }

    // ----------------------------------------------------------------
    //  Data loading & real-time sync
    // ----------------------------------------------------------------

    async loadFile(file: TFile) {
        this.file = file;
        const content = await this.app.vault.read(file);
        this.renderMindMap(content);

        // Watch file changes → smooth in-place update via setData()
        this.registerEvent(
            this.app.vault.on('modify', (f) => {
                if (f === this.file) this.updateData();
            })
        );
    }

    /**
     * Preprocess Obsidian-flavoured markdown before handing it to markmap-lib.
     * – Converts `![[image.png]]` and `![[image.png|alt]]` to standard `![alt](url)`.
     */
    private preprocessMarkdown(markdown: string): string {
        return markdown.replace(
            /!\[\[([^\]|]+?)(?:\|([^\]]*))?\]\]/g,
            (_match, linkPath: string, alt: string | undefined) => {
                const resolved = this.app.metadataCache.getFirstLinkpathDest(
                    linkPath.trim(),
                    this.file?.path || '',
                );
                if (resolved && this.isImageFile(resolved)) {
                    const url = this.app.vault.getResourcePath(resolved);
                    return `![${alt || resolved.basename}](${url})`;
                }
                return _match;
            },
        );
    }

    private isImageFile(file: TFile): boolean {
        return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].includes(
            file.extension.toLowerCase(),
        );
    }

    // ----------------------------------------------------------------
    //  Rendering
    // ----------------------------------------------------------------

    private renderMindMap(markdown: string) {
        this.mindmapContent.empty();

        if (this.markmap) {
            this.markmap.destroy();
            this.markmap = null;
        }

        const svg = this.mindmapContent.createSvg('svg');
        svg.addClass('mindmap-svg');
        svg.style.width = '100%';
        svg.style.height = '100%';
        this.svg = svg;

        const processed = this.preprocessMarkdown(markdown);
        const { root } = this.plugin.transformer.transform(processed);

        const s = this.plugin.settings;
        this.markmap = Markmap.create(
            svg,
            {
                color: branchColor,
                duration: s.enableAnimation ? 300 : 0,
                spacingVertical: s.spacingVertical,
                spacingHorizontal: s.spacingHorizontal,
                paddingX: s.paddingX,
                autoFit: false,          // ← don't jump viewport on collapse / expand
                initialExpandLevel: s.maxDepth === -1 ? -1 : s.maxDepth,
            } as any,
            root,
        );

        // Fit once after the very first render
        requestAnimationFrame(() => this.markmap?.fit());

        this.applyTheme();
    }

    /** Smooth in-place update — no destroy / recreate, viewport stays put */
    private async updateData() {
        if (!this.file || !this.markmap) return;
        try {
            const md = await this.app.vault.read(this.file);
            const processed = this.preprocessMarkdown(md);
            const { root } = this.plugin.transformer.transform(processed);
            await this.markmap.setData(root);
        } catch (err) {
            console.error('MindMap update error:', err);
        }
    }

    private applyTheme() {
        const theme =
            this.plugin.settings.theme === 'auto'
                ? document.body.classList.contains('theme-dark')
                    ? 'dark'
                    : 'light'
                : this.plugin.settings.theme;
        this.mindmapContent.toggleClass('mindmap-dark', theme === 'dark');
    }

    // ----------------------------------------------------------------
    //  Actions
    // ----------------------------------------------------------------

    async refresh() {
        if (this.file) {
            const md = await this.app.vault.read(this.file);
            this.renderMindMap(md);
            new Notice('MindMap refreshed');
        }
    }

    zoomIn() { this.markmap?.rescale(1.25); }
    zoomOut() { this.markmap?.rescale(0.8); }
    fitView() { this.markmap?.fit(); }

    // ----------------------------------------------------------------
    //  Export helpers
    // ----------------------------------------------------------------

    private cloneSvgForExport(): SVGSVGElement | null {
        if (!this.svg) return null;
        const clone = this.svg.cloneNode(true) as SVGSVGElement;
        const r = this.svg.getBoundingClientRect();
        clone.setAttribute('width', String(r.width));
        clone.setAttribute('height', String(r.height));
        return clone;
    }

    async exportAsPNG() {
        if (!this.svg || !this.file) return;
        try {
            const clone = this.cloneSvgForExport();
            if (!clone) return;
            const svgStr = new XMLSerializer().serializeToString(clone);
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d')!;
            const img = new Image();

            await new Promise<void>((resolve, reject) => {
                img.onload = () => {
                    canvas.width = this.svg!.clientWidth * 2;
                    canvas.height = this.svg!.clientHeight * 2;
                    ctx.fillStyle = '#ffffff';
                    ctx.fillRect(0, 0, canvas.width, canvas.height);
                    ctx.scale(2, 2);
                    ctx.drawImage(img, 0, 0);
                    canvas.toBlob((blob) => {
                        if (blob) {
                            const a = document.createElement('a');
                            a.href = URL.createObjectURL(blob);
                            a.download = `${this.file!.basename}-mindmap.png`;
                            a.click();
                            URL.revokeObjectURL(a.href);
                            new Notice('Exported as PNG');
                        }
                        resolve();
                    });
                };
                img.onerror = reject;
                img.src =
                    'data:image/svg+xml;base64,' +
                    btoa(unescape(encodeURIComponent(svgStr)));
            });
        } catch (e) {
            new Notice('Failed to export PNG');
            console.error(e);
        }
    }

    async exportAsSVG() {
        if (!this.svg || !this.file) return;
        try {
            const clone = this.cloneSvgForExport();
            if (!clone) return;
            const svgStr = new XMLSerializer().serializeToString(clone);
            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' }));
            a.download = `${this.file.basename}-mindmap.svg`;
            a.click();
            URL.revokeObjectURL(a.href);
            new Notice('Exported as SVG');
        } catch (e) {
            new Notice('Failed to export SVG');
            console.error(e);
        }
    }

    async exportAsHTML() {
        if (!this.svg || !this.file) return;
        try {
            const md = await this.app.vault.read(this.file);
            // For HTML export use raw markdown (no Obsidian wiki-link resolution)
            const { root } = this.plugin.transformer.transform(md);

            const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${this.file.basename} - MindMap</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body,#mm{width:100%;height:100vh;font-family:system-ui,-apple-system,sans-serif;background:#f8f9fa}
svg.markmap{display:block;width:100%;height:100%}
.bar{position:fixed;bottom:16px;right:16px;display:flex;gap:6px;z-index:100}
.bar button{padding:8px 14px;border:1px solid #ddd;border-radius:6px;background:#fff;cursor:pointer;
  font-size:14px;box-shadow:0 2px 6px rgba(0,0,0,.1);transition:background .2s}
.bar button:hover{background:#e9ecef}
</style>
</head>
<body>
<svg id="mm"></svg>
<div class="bar">
  <button onclick="mm.fit()" title="Fit View">🎯</button>
  <button onclick="mm.rescale(1.25)" title="Zoom In">➕</button>
  <button onclick="mm.rescale(0.8)" title="Zoom Out">➖</button>
</div>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script src="https://cdn.jsdelivr.net/npm/markmap-view@0.18"></script>
<script>
window.mm = markmap.Markmap.create('svg#mm', {autoFit:true, duration:300}, ${JSON.stringify(root)});
</script>
</body>
</html>`;

            const a = document.createElement('a');
            a.href = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
            a.download = `${this.file.basename}-mindmap.html`;
            a.click();
            URL.revokeObjectURL(a.href);
            new Notice('Exported as HTML');
        } catch (e) {
            new Notice('Failed to export HTML');
            console.error(e);
        }
    }

    // ----------------------------------------------------------------
    //  State persistence
    // ----------------------------------------------------------------

    async setState(state: any, result: any) {
        if (state.file) {
            const f = this.app.vault.getAbstractFileByPath(state.file);
            if (f instanceof TFile) await this.loadFile(f);
        }
        return super.setState(state, result);
    }

    getState() {
        return { file: this.file?.path };
    }

    async onClose() {
        if (this.markmap) {
            this.markmap.destroy();
            this.markmap = null;
        }
    }
}

// =========================================================================
//  Settings Tab
// =========================================================================
class MindMapSettingTab extends PluginSettingTab {
    plugin: MindMapPlugin;

    constructor(app: App, plugin: MindMapPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display() {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.createEl('h2', { text: 'MindMap Plus Settings' });

        // ---- Visual ----
        containerEl.createEl('h3', { text: '🎨 Visual', cls: 'mindmap-settings-section-title' });

        new Setting(containerEl)
            .setName('Theme')
            .setDesc('Mindmap colour theme')
            .addDropdown((d) =>
                d
                    .addOption('auto', 'Auto')
                    .addOption('light', 'Light')
                    .addOption('dark', 'Dark')
                    .setValue(this.plugin.settings.theme)
                    .onChange(async (v: any) => {
                        this.plugin.settings.theme = v;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Font Size')
            .setDesc('Node font size (px)')
            .addSlider((s) =>
                s
                    .setLimits(10, 24, 1)
                    .setValue(this.plugin.settings.fontSize)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        this.plugin.settings.fontSize = v;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Line Width')
            .setDesc('Width of connecting lines')
            .addSlider((s) =>
                s
                    .setLimits(1, 5, 0.5)
                    .setValue(this.plugin.settings.lineWidth)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        this.plugin.settings.lineWidth = v;
                        await this.plugin.saveSettings();
                    }),
            );

        // ---- Spacing ----
        containerEl.createEl('h3', { text: '📐 Spacing', cls: 'mindmap-settings-section-title' });

        new Setting(containerEl)
            .setName('Vertical Spacing')
            .setDesc('Space between sibling nodes')
            .addSlider((s) =>
                s
                    .setLimits(5, 30, 5)
                    .setValue(this.plugin.settings.spacingVertical)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        this.plugin.settings.spacingVertical = v;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Horizontal Spacing')
            .setDesc('Space between parent and child levels')
            .addSlider((s) =>
                s
                    .setLimits(40, 150, 10)
                    .setValue(this.plugin.settings.spacingHorizontal)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        this.plugin.settings.spacingHorizontal = v;
                        await this.plugin.saveSettings();
                    }),
            );

        new Setting(containerEl)
            .setName('Max Depth')
            .setDesc('Initial expansion depth (−1 = expand all)')
            .addSlider((s) =>
                s
                    .setLimits(-1, 10, 1)
                    .setValue(this.plugin.settings.maxDepth)
                    .setDynamicTooltip()
                    .onChange(async (v) => {
                        this.plugin.settings.maxDepth = v;
                        await this.plugin.saveSettings();
                    }),
            );

        // ---- Behaviour ----
        containerEl.createEl('h3', { text: '⚙️ Behaviour', cls: 'mindmap-settings-section-title' });

        new Setting(containerEl)
            .setName('Enable Animation')
            .setDesc('Smooth expand / collapse transitions')
            .addToggle((t) =>
                t.setValue(this.plugin.settings.enableAnimation).onChange(async (v) => {
                    this.plugin.settings.enableAnimation = v;
                    await this.plugin.saveSettings();
                }),
            );

        new Setting(containerEl)
            .setName('Show Toolbar')
            .setDesc('Display the quick-action toolbar')
            .addToggle((t) =>
                t.setValue(this.plugin.settings.showToolbar).onChange(async (v) => {
                    this.plugin.settings.showToolbar = v;
                    await this.plugin.saveSettings();
                }),
            );
    }
}
