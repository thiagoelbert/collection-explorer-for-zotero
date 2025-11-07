# Zotero File Explorer

[![Zotero 7](https://img.shields.io/badge/Zotero-7.0+-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-✓-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Built with zotero-plugin-template](https://img.shields.io/badge/Built%20with-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

**Zotero File Explorer** makes the Zotero **Items** panel behave more like Windows Explorer:  
when you open a collection, the top of the middle list shows its **subcollections as folder-like rows** (click to navigate), with your normal items below.

## ✨ Features

- **Explorer-style navigation**: subcollections appear as clickable “folder rows” above items.
- **Native look & alignment**: rows align to Zotero’s item table columns (widths tracked live).
- **Fast & light**: rAF-coalesced rendering and minimal data fetching (no heavy item counting).
- **Safe**: doesn’t modify or hide your items; only augments the list view.
- **Zotero 7** compatible.

> Works great in libraries with deep collection trees; no extra panes, no flashing UI.

## 📷 Screenshots

> _Add a couple of images here later_
- Open a parent collection → see subcollections as folders at the top → click to drill down.

## ✅ Requirements

- **Zotero**: 7.0.0 or newer (tested on 7.0.26)
- **Windows / macOS / Linux** (UI is platform-agnostic)

## 🧪 Development (live-reload)

This project uses the official **zotero-plugin-template** (Vite + TS + ztoolkit).

```bash
# 1) Install deps
npm install

# 2) Start dev runner (injects into Zotero; auto rebuilds on save)
npm start
```

- The dev runner launches Zotero (or attaches) and hot-injects the plugin.
- Stop the runner to avoid interference when testing the packaged XPI.

## 📦 Production install (XPI)

1. Ensure your `addon/manifest.json` is set (example below).
2. Build the XPI:

```bash
# Clean + build (adjust if your template uses a different script)
npm run build
```

The template usually emits an `.xpi` in `build/` (or `.scaffold/build/`).  
If your template defines a separate packaging script, use that (e.g. `npm run xpi`).

3. **Install in Zotero**:  
   Zotero → **Tools → Add-ons** → gear menu → **Install Add-on From File…**  
   Choose the generated `.xpi`, confirm, and restart if asked.

> Tip: Drag & drop the `.xpi` onto Zotero’s window also works.

## 🧼 Clean builds & repo hygiene

Keep dev artifacts out of releases and your XPI lean.

**Suggested scripts (package.json):**
```json
{
  "scripts": {
    "clean": "rimraf build dist addon/build .rollup.cache .vite .scaffold/build",
    "build": "vite build",
    "xpi": "npm run clean && npm run build"
  }
}
```

Install `rimraf` once:
```bash
npm i -D rimraf
```

**.gitignore** essentials:
```
node_modules/
build/
dist/
.vite/
.rollup.cache/
.scaffold/
*.log
*.xpi
*.zip
.vscode/
.DS_Store
Thumbs.db
```

> After building, you can rename the `.xpi` to `.zip` and peek inside—it should contain only runtime assets (e.g., `manifest.json`, `content/`, `build/`, `locale/`).

## ⚙️ Manifest example

`addon/manifest.json`:

```json
{
  "manifest_version": 2,
  "name": "Zotero File Explorer",
  "version": "0.1.0",
  "description": "Show subcollections as folder-like rows at the top of the items list, for Explorer-style navigation.",
  "homepage_url": "https://github.com/yourname/zotero-file-explorer",
  "author": "Thiago",
  "icons": {
    "48": "content/icons/favicon@0.5x.png",
    "96": "content/icons/favicon.png"
  },
  "applications": {
    "zotero": {
      "id": "zotero-file-explorer@thiago",
      "strict_min_version": "7.0.0",
      "strict_max_version": "7.*"
    }
  }
}
```

- Keep the **id** stable across releases.
- Omit `update_url` until you host your own updates.

## 🧭 How it works (short)

- On collection change, we render a small **rowgroup** at the top of the items list.  
- Folder rows are grid-aligned to the items header widths and update on column changes.
- We avoid heavy calls (e.g., enumerating all items) to keep the UI responsive.

## 🐞 Troubleshooting

- Seeing double UI or weird lag?  
  Make sure the **dev runner (`npm start`) is not running** while testing the packaged XPI.
- Plugin won’t load?  
  Check **Help → Debug Output Logging** for errors (e.g., wrong icon paths or manifest typos).
- No folder rows appear?  
  Ensure a collection (not “My Library” root or special views) is selected and that it has subcollections.

## 🗺️ Roadmap

- Keyboard navigation polish (arrow keys between folder rows)
- Optional badges (item counts via lazy hover fetch)
- Per-collection settings / show-hide toggle
- Unit tests for rendering + observers

## 🤝 Contributing

PRs welcome!  
Please keep PRs small and focused. Run the linter/formatter and test on Zotero 7.

## 📄 License

AGPL-3.0 (same as the template). See `LICENSE`.

## 🙏 Credits

Built with:
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
- [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [Zotero Types](https://github.com/windingwind/zotero-types)
- The Zotero team & community ❤️
