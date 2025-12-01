# Collection Explorer for Zotero

[![Zotero 7](https://img.shields.io/badge/Zotero-7.0%2B-green?style=flat-square&logo=zotero&logoColor=CC2936)](https://www.zotero.org) [![TypeScript](https://img.shields.io/badge/TypeScript-✓-blue?style=flat-square&logo=typescript)](https://www.typescriptlang.org/) [![Template](https://img.shields.io/badge/Built%20with-Zotero%20Plugin%20Template-blue?style=flat-square&logo=github)](https://github.com/windingwind/zotero-plugin-template)

**Collection Explorer for Zotero** turns Zotero’s Items pane into an Explorer-style navigator:  
whenever you open a collection, its **subcollections appear as folder-like rows** at the top of the items list—just like folders at the top of a filesystem.

---

## Features

- **Explorer-style navigation**  
  Subcollections appear as clickable “folder rows” above items.

- **Back / Forward / Up navigation strip**  
  Includes history, breadcrumbs, path editing, and overflow handling in an optional navigation bar.

- **Fully aligned with Zotero’s native UI**  
  Folder rows use the exact same grid as the item table.

- **Non-invasive**  
  Doesn’t replace Zotero components; all injected UI is mounted/unmounted cleanly.

- **Works great for large hierarchical libraries**

---

## Screenshots

<p align="center">

  <img src="https://github.com/user-attachments/assets/14fa9507-221b-44bd-aab9-2baa0d55da8e" width="720" alt="Subcollections rendered as folders at the top of the item list" />

</p>

<p align="center">

  <img src="https://github.com/user-attachments/assets/ae7ffe6f-9bdf-4055-8781-43f8c34427c7" width="720" alt="Explorer rows displayed inside a subcollection with two nested folders" />

</p>

<p align="center">
  <img src="https://github.com/user-attachments/assets/ebcdd9f0-b0ae-45a9-a48b-e1b83661035b" width="360" alt="Keyboard focus on a folder row demonstrating native selection visuals" />
  &nbsp;&nbsp;&nbsp;
  <img src="https://github.com/user-attachments/assets/aa0ade31-7245-40fc-8a93-405e15101703" width="360" alt="Minimal set of child collections showing how fast folder navigation works" />
</p>

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

## Installation

Download the latest `.xpi` from the **Releases** page of this repository.

In Zotero:  
**Tools → Add-ons → Gear icon → Install Add-on From File…**  
Select the `.xpi` and restart if prompted.

## Requirements

- **Zotero**: 7.0.0 or newer (tested on 7.0.26)
- **Windows / macOS / Linux** (UI is platform-agnostic)

---

## Contributing

PRs welcome!

## License

AGPL-3.0 (same as the template). See `LICENSE`.

## Credits

Built with:

- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template)
- [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit)
- [Zotero Types](https://github.com/windingwind/zotero-types)
- The Zotero team & community
