# Collection Explorer for Zotero

[![Zotero 7](https://img.shields.io/badge/Zotero-7.0%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org)  [![TypeScript](https://img.shields.io/badge/TypeScript-✓-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)  [![Template](https://img.shields.io/badge/Built%20with-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

**Collection Explorer for Zotero** turns Zotero’s Items pane into an Explorer-style navigator:  
whenever you open a collection, its **subcollections appear as folder-like rows** at the top of the items list—just like folders at the top of a filesystem.

---

## ⚠️ A note from the author

I am **not a developer** and had **no previous experience with TypeScript, Zotero, UI code, or plugin architecture**.  
This entire plugin was built through **incremental guidance from LLM assistants**.

I am sharing this because:

- the plugin is useful,
- others may help to build it

**Please treat this addon as experimental.**  
If you find bugs or want to improve the code, PRs are extremely welcome.

---

## ✨ Features

- 🗂 **Explorer-style navigation**  
  Subcollections appear as clickable “folder rows” above items.

- 📌 **Back / Forward / Up navigation strip**  
  Includes history, breadcrumbs, path editing, and overflow handling.

- 🎨 **Fully aligned with Zotero’s native UI**  
  Folder rows use the exact same grid as the item table.

- 🧩 **Non-invasive**  
  Doesn’t replace Zotero components; all injected UI is mounted/unmounted cleanly.

- 🧭 **Works great for large hierarchical libraries**

---

## 📦 Installation

Download the latest `.xpi` from the **Releases** page of this repository.

In Zotero:  
**Tools → Add-ons → Gear icon → Install Add-on From File…**  
Select the `.xpi` and restart if prompted.

## ✅ Requirements

- **Zotero**: 7.0.0 or newer (tested on 7.0.26)
- **Windows / macOS / Linux** (UI is platform-agnostic)

---

## 🤝 Contributing

PRs welcome!

## 📄 License

AGPL-3.0 (same as the template). See `LICENSE`.

## 🙏 Credits

Built with:

- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
- [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [Zotero Types](https://github.com/windingwind/zotero-types)
- The Zotero team & community
