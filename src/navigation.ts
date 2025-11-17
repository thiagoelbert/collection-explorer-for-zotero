import { getDocument, getPane } from "./env";

type NavigationDeps = {
  scheduleRerender: (delay?: number) => void;
};

const deps: NavigationDeps = {
  scheduleRerender: () => { },
};

export function configureNavigation(newDeps: NavigationDeps) {
  deps.scheduleRerender = newDeps.scheduleRerender;
}

// --- history ---
const NAV_DEBUG = false;
const navHistory: number[] = [];
let navIndex = -1;
const pendingHistoryNavigations: number[] = [];
let navStripEnabled = true;
let navStripCleanup: (() => void) | null = null;
let navOverflowMenuCleanup: (() => void) | null = null;
let navOverflowMenuAnchor: HTMLElement | null = null;

function logNav(message: string, extra?: Record<string, unknown>) {
  if (!NAV_DEBUG) return;
  const stack = navHistory.join(">");
  const pending = pendingHistoryNavigations.join(">");
  const state = `idx=${navIndex} hist=[${stack}] pending=[${pending}]`;
  if (extra && Object.keys(extra).length) {
    ztoolkit.log(`[Nav] ${message} | ${state} | ${JSON.stringify(extra)}`);
  } else {
    ztoolkit.log(`[Nav] ${message} | ${state}`);
  }
}

type PathSeg = { label: string; collectionID: number | null };

type BreadcrumbNode = {
  seg: PathSeg;
  crumb: HTMLSpanElement;
  separator: HTMLSpanElement | null;
};

export function isNavStripEnabled() {
  return navStripEnabled;
}

export function setNavStripEnabled(value: boolean) {
  if (navStripEnabled === value) return;
  navStripEnabled = value;
  if (!value) {
    removeNavStrip();
  } else {
    updateNavStrip();
  }
}

export function navigateUp() {
  const pane = getPane();
  const cur = pane?.getSelectedCollection();
  if (!cur?.parentID) return;
  navigateToCollection(cur.parentID);
  deps.scheduleRerender(120);
}

function commitPath(raw: string) {
  const target = resolveCollectionByPath(raw.trim());
  const doc = getDocument();
  const strip = doc.getElementById("thiago-nav-strip") as any;
  if (target) {
    navigateToCollection(target.id);
    deps.scheduleRerender(120);
  }
  if (strip?.__stopEditPath) strip.__stopEditPath();
}

function resolveCollectionByPath(input: string): any | null {
  const parts = input
    .split(/[\\/]/)
    .map(s => s.trim())
    .filter(Boolean);
  if (!parts.length) return null;

  const pane = getPane();
  const sel = pane?.getSelectedCollection();
  const currentLibID = sel?.libraryID ?? Zotero.Libraries.userLibraryID;

  let libID = currentLibID;
  const allLibs = Zotero.Libraries.getAll();
  const first = parts[0].toLowerCase();
  const libHit = allLibs.find((l: any) => (l.name || "").toLowerCase() === first);
  let idx = 0;
  if (libHit) { libID = libHit.libraryID; idx = 1; }

  let parentID: number | null = null;
  let found: any = null;
  for (; idx < parts.length; idx++) {
    const name = parts[idx].toLowerCase();
    const siblings = parentID == null
      ? Zotero.Collections.getByLibrary(libID).filter((c: any) => !c.parentID)
      : Zotero.Collections.getByParent(parentID);
    found = siblings.find((c: any) => (c.name || "").toLowerCase() === name);
    if (!found) return null;
    parentID = found.id;
  }
  return found;
}

function getPathSegments(selected: any): PathSeg[] {
  const segs: PathSeg[] = [];
  if (!selected) {
    return [{ label: "Library", collectionID: null }];
  }
  const lib = Zotero.Libraries.get(selected.libraryID);
  const libName = (lib as any)?.name || "Library";
  segs.push({ label: libName, collectionID: null });

  const chain: any[] = [];
  let cur = selected;
  while (cur) { chain.unshift(cur); if (!cur.parentID) break; cur = Zotero.Collections.get(cur.parentID); }
  chain.forEach(col => segs.push({ label: col.name, collectionID: col.id }));
  return segs;
}

export function getCurrentPathString(): string {
  const sel = getPane()?.getSelectedCollection();
  if (!sel) return "Library";
  const segs = getPathSegments(sel).map(s => s.label);
  return segs.join("\\");
}

function ensureNavStripCSS(doc: Document) {
  if (doc.getElementById("thiago-nav-strip-style")) return;
  const s = doc.createElement("style");
  s.id = "thiago-nav-strip-style";
  s.textContent = `
  /* container */
  #thiago-nav-strip {
    display:flex; align-items:center; gap:8px;
    padding:6px 8px;
    border-bottom:1px solid var(--color-border, #dadada);
    background:var(--material-toolbar, #f9f9f9);
    position:sticky; top:0; z-index: 1;
    box-sizing:border-box;
    max-width:100%;
  }
  #thiago-nav-strip button {
    border:none; background:transparent; padding:4px 6px; border-radius:6px;
    font-size:14px; line-height:1; cursor:pointer;
  }
  #thiago-nav-strip button:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  #thiago-nav-strip button:disabled { opacity:.35; cursor:default; }
  #thiago-nav-path {
    min-width: 240px; flex:1; display:flex; align-items:center; gap:6px;
    padding:2px 6px; border-radius:6px; background: var(--material-button, #fff); border:1px solid var(--color-border, #dadada);
    overflow:hidden;
  }
  #thiago-nav-breadcrumbs {
    display:flex; align-items:center; gap:4px;
    flex-wrap:nowrap;
    overflow:hidden;
    min-width:0;
    white-space:nowrap;
  }
  .thiago-crumb {
    display:inline-flex; align-items:center; gap:6px; white-space:nowrap; padding:2px 4px; border-radius:4px; cursor:pointer;
    flex-shrink:0;
  }
  .thiago-crumb:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  .thiago-crumb.thiago-nav-menu-open { background: var(--accent-blue20, rgba(64,114,229,.2)); }
  .thiago-crumb-ellipsis { font-weight:600; }
  .thiago-crumb-sep {
    opacity:.6;
    user-select:none;
    margin:0 4px;
  }
  .thiago-nav-overflow-menu {
    position:fixed;
    display:flex;
    flex-direction:column;
    background: var(--material-button, #fff);
    border:1px solid var(--color-border, #dadada);
    border-radius:6px;
    box-shadow:0 6px 20px rgba(0,0,0,.15);
    padding:4px 0;
    z-index:2147483647;
    min-width:160px;
  }
  .thiago-nav-overflow-menu button {
    background:transparent;
    border:none;
    text-align:left;
    padding:6px 12px;
    font:inherit;
    cursor:pointer;
  }
  .thiago-nav-overflow-menu button:hover { background: var(--accent-blue10, rgba(64,114,229,.1)); }
  .thiago-nav-overflow-menu button:disabled { opacity:.5; cursor:default; }
  #thiago-nav-input {
    width:100%; border:none; outline:none; background:transparent; font:inherit; padding:0;
  }
  #thiago-nav-path.editing { outline:2px solid var(--accent-blue30, rgba(64,114,229,.3)); }
  `;
  const host = doc.head || doc.querySelector("head") || doc.documentElement;
  if (host) host.appendChild(s);
}

export function pushToHistory(id: number | null) {
  if (id == null) return;
  if (
    pendingHistoryNavigations.length &&
    pendingHistoryNavigations[0] === id
  ) {
    pendingHistoryNavigations.shift();
    updateNavButtonsEnabled();
    logNav("push skip (pending match)", { id });
    return;
  }
  if (pendingHistoryNavigations.length) {
    logNav("push ignored (waiting for pending match)", { id, waitingFor: pendingHistoryNavigations[0] });
    return;
  }
  if (navIndex >= 0 && navHistory[navIndex] === id) {
    updateNavButtonsEnabled();
    logNav("push no-op (same index)", { id });
    return;
  }
  if (navHistory.length && navHistory[navHistory.length - 1] === id) {
    navIndex = navHistory.length - 1;
    updateNavButtonsEnabled();
    logNav("push collapse duplicate tail", { id });
    return;
  }
  if (navIndex < navHistory.length - 1) navHistory.splice(navIndex + 1);
  navHistory.push(id);
  navIndex = navHistory.length - 1;
  updateNavButtonsEnabled();
  logNav("push add", { id });
}

function canGo(delta: -1 | 1) {
  const i = navIndex + delta;
  return i >= 0 && i < navHistory.length;
}

export function navigateHistory(delta: -1 | 1) {
  if (!canGo(delta)) return;
  navIndex += delta;
  const id = navHistory[navIndex];
  pendingHistoryNavigations.push(id);
  logNav("navigate", { delta, id });
  navigateToCollection(id);
  deps.scheduleRerender(120);
  updateNavButtonsEnabled();
}

export function mountNavStrip(doc: Document) {
  if (!navStripEnabled) {
    removeNavStrip(doc);
    return;
  }
  if (doc.getElementById("thiago-nav-strip")) return;

  const pane = getPane();
  const root = pane?.itemsView?.domEl as HTMLElement | null;
  if (!root) return;

  const windowed =
    root.querySelector(".virtualized-table-list") ||
    root.querySelector("#virtualized-table-list") ||
    root.querySelector(".windowed-list");
  const itemsToolbar =
    doc.getElementById("zotero-items-toolbar") ||
    root.querySelector<HTMLElement>("#zotero-items-toolbar");

  const strip = doc.createElement("div");
  strip.id = "thiago-nav-strip";
  strip.style.display = "flex";
  strip.style.alignItems = "center";
  strip.style.gap = "8px";
  strip.style.padding = "6px 8px";
  strip.style.borderBottom = "1px solid var(--color-border, #dadada)";
  strip.style.background = "var(--material-toolbar, #f9f9f9)";

  const buttonsWrap = doc.createElement("div");
  buttonsWrap.style.display = "flex";
  buttonsWrap.style.alignItems = "center";
  buttonsWrap.style.gap = "4px";

  const backBtn = createNavButton(doc, "thiago-nav-back", "Back (Alt+Left)", "\u2190");
  const fwdBtn = createNavButton(doc, "thiago-nav-forward", "Forward (Alt+Right)", "\u2192");
  const upBtn = createNavButton(doc, "thiago-nav-up", "Up (Alt+Up)", "\u2191");
  buttonsWrap.append(backBtn, fwdBtn, upBtn);

  const pathBox = doc.createElement("div");
  pathBox.id = "thiago-nav-path";
  pathBox.style.minWidth = "240px";
  pathBox.style.flex = "1";
  pathBox.style.display = "flex";
  pathBox.style.alignItems = "center";
  pathBox.style.gap = "6px";
  pathBox.style.padding = "2px 6px";
  pathBox.style.borderRadius = "6px";
  pathBox.style.background = "var(--material-button, #fff)";
  pathBox.style.border = "1px solid var(--color-border, #dadada)";
  pathBox.title = "Click to edit / Ctrl+L to focus";

  const crumbs = doc.createElement("div");
  crumbs.id = "thiago-nav-breadcrumbs";
  crumbs.style.display = "flex";
  crumbs.style.alignItems = "center";
  crumbs.style.gap = "4px";
  crumbs.style.flexWrap = "nowrap";
  crumbs.style.overflow = "hidden";
  crumbs.style.minWidth = "0";
  crumbs.style.whiteSpace = "nowrap";
  crumbs.style.flex = "1";

  const input = doc.createElement("input");
  input.id = "thiago-nav-input";
  input.style.display = "none";
  input.style.flex = "1";
  input.style.border = "none";
  input.style.outline = "none";
  input.style.background = "transparent";

  const pathRow = doc.createElement("div");
  pathRow.style.display = "flex";
  pathRow.style.alignItems = "center";
  pathRow.style.gap = "6px";
  pathRow.style.width = "100%";

  pathBox.append(crumbs, input);
  pathRow.append(pathBox);

  strip.append(buttonsWrap, pathRow);
  const cleanupTasks: Array<() => void> = [];

  const itemsPaneContainer =
    doc.getElementById("zotero-items-pane-container") ||
    (root.closest("#zotero-items-pane-container") as HTMLElement | null);
  const toolbarContainer =
    doc.getElementById("zotero-toolbar-item-tree") ||
    (itemsToolbar?.closest("#zotero-toolbar-item-tree") as HTMLElement | null);

  if (
    itemsPaneContainer &&
    toolbarContainer &&
    toolbarContainer.parentElement === itemsPaneContainer
  ) {
    toolbarContainer.insertAdjacentElement("afterend", strip);
  } else if (itemsToolbar?.parentElement) {
    itemsToolbar.parentElement.insertBefore(strip, itemsToolbar.nextSibling);
  } else if (windowed?.parentElement) {
    windowed.parentElement.insertBefore(strip, windowed);
  } else {
    root.prepend(strip);
  }

  backBtn.addEventListener("click", () => navigateHistory(-1));
  fwdBtn.addEventListener("click", () => navigateHistory(1));
  upBtn.addEventListener("click", () => navigateUp());

  pathBox.addEventListener("click", () => {
    if (pathBox.classList.contains("editing")) return;
    startEditPath(true);
  });
  input.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      commitPath(input.value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      stopEditPath();
    }
  });
  input.addEventListener("blur", () => stopEditPath());

  const widthCleanup = setupNavStripWidthTracking(doc, strip);
  if (widthCleanup) cleanupTasks.push(widthCleanup);

  const keydownHandler = (ev: KeyboardEvent) => {
    if (ev.altKey && ev.key === "ArrowLeft") {
      ev.preventDefault();
      navigateHistory(-1);
    } else if (ev.altKey && ev.key === "ArrowRight") {
      ev.preventDefault();
      navigateHistory(1);
    } else if (ev.altKey && ev.key === "ArrowUp") {
      ev.preventDefault();
      navigateUp();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === "l") {
      ev.preventDefault();
      startEditPath(true);
    }
  };
  doc.addEventListener("keydown", keydownHandler);
  cleanupTasks.push(() => {
    doc.removeEventListener("keydown", keydownHandler);
  });
  navStripCleanup = () => {
    cleanupTasks.splice(0).forEach(fn => {
      try {
        fn();
      } catch { }
    });
    navStripCleanup = null;
  };

  function startEditPath(selectAll = false) {
    closeBreadcrumbOverflowMenu();
    pathBox.classList.add("editing");
    crumbs.style.display = "none";
    input.style.display = "block";
    input.value = getCurrentPathString();
    if (selectAll) {
      input.select();
    } else {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  function stopEditPath() {
    pathBox.classList.remove("editing");
    crumbs.style.display = "flex";
    input.style.display = "none";
  }

  (strip as any).__stopEditPath = stopEditPath;
  ensureNavStripCSS(doc);
  updateNavButtonsEnabled();
}

function createNavButton(doc: Document, id: string, title: string, glyph: string) {
  const btn = doc.createElement("button");
  btn.id = id;
  btn.textContent = glyph;
  btn.title = title;
  btn.setAttribute("aria-label", title);
  return btn;
}

export function updateNavStrip(selected?: any) {
  const doc = getDocument();
  if (!navStripEnabled) {
    removeNavStrip(doc);
    return;
  }
  const strip = doc.getElementById("thiago-nav-strip");
  if (!strip) {
    mountNavStrip(doc);
    return updateNavStrip(selected);
  }
  const crumbs = doc.getElementById("thiago-nav-breadcrumbs");
  if (!crumbs) return;
  closeBreadcrumbOverflowMenu();
  crumbs.textContent = "";
  const sel = selected ?? getPane()?.getSelectedCollection();
  const segs = getPathSegments(sel);
  const crumbNodes: BreadcrumbNode[] = [];
  segs.forEach((seg, idx) => {
    let separator: HTMLSpanElement | null = null;
    if (idx > 0) {
      const sep = doc.createElement("span");
      sep.className = "thiago-crumb-sep";
      sep.textContent = ">";
      crumbs.appendChild(sep);
      separator = sep;
    }
    const crumb = doc.createElement("span");
    crumb.className = "thiago-crumb";
    crumb.textContent = seg.label;
    crumb.title = seg.label;
    crumb.tabIndex = 0;
    crumb.setAttribute("data-thiago-label", seg.label);
    if (seg.collectionID != null) {
      crumb.setAttribute("data-thiago-collection-id", String(seg.collectionID));
    } else {
      crumb.removeAttribute("data-thiago-collection-id");
    }
    crumb.addEventListener("click", () => {
      if (seg.collectionID != null) {
        navigateToCollection(seg.collectionID);
        deps.scheduleRerender(120);
      }
    });
    crumb.addEventListener("keydown", (ev: KeyboardEvent) => {
      if ((ev.key === "Enter" || ev.key === " ") && seg.collectionID != null) {
        ev.preventDefault();
        navigateToCollection(seg.collectionID);
        deps.scheduleRerender(120);
      }
    });
    crumbs.appendChild(crumb);
    crumbNodes.push({ seg, crumb, separator });
  });
  scheduleBreadcrumbOverflowMeasurement(doc, crumbs, crumbNodes);
  updateNavButtonsEnabled();
}

function updateNavButtonsEnabled() {
  const doc = getDocument();
  const backBtn = doc.getElementById("thiago-nav-back") as HTMLButtonElement | null;
  const fwdBtn = doc.getElementById("thiago-nav-forward") as HTMLButtonElement | null;
  if (backBtn) backBtn.disabled = !canGo(-1);
  if (fwdBtn) fwdBtn.disabled = !canGo(1);
  logNav("buttons updated", { backEnabled: !backBtn?.disabled, forwardEnabled: !fwdBtn?.disabled });
}

export function navigateToCollection(collectionID: number) {
  const pane = getPane();
  if (!pane?.collectionsView) {
    ztoolkit.log("No pane or collectionsView available");
    return;
  }
  try {
    const cv = pane.collectionsView;
    expandParentCollections(collectionID);

    setTimeout(() => {
      let targetRowIndex = -1;
      for (let i = 0; i < cv._rows.length; i++) {
        const row = cv._rows[i];
        if (row.ref?.id === collectionID) { targetRowIndex = i; break; }
      }
      if (targetRowIndex === -1) return;

      if (cv.selection) {
        cv.selection.select(targetRowIndex);
        if (cv.tree?.invalidate) cv.tree.invalidate();
      } else if (typeof cv._selectRow === "function") {
        cv._selectRow(targetRowIndex);
      } else if (cv._treebox?.getElementByIndex) {
        cv._treebox.getElementByIndex(targetRowIndex)?.click();
      }
      deps.scheduleRerender(120);
    }, 200);

  } catch (e) {
    ztoolkit.log(`navigateToCollection error: ${e}`);
  }
}

function expandParentCollections(collectionID: number) {
  const pane = getPane();
  if (!pane?.collectionsView) return;

  try {
    const collection = Zotero.Collections.get(collectionID);
    if (!collection) return;

    const cv = pane.collectionsView;
    const parentIDs: number[] = [];
    let current = collection;
    while (current.parentID) {
      parentIDs.unshift(current.parentID);
      current = Zotero.Collections.get(current.parentID);
    }

    for (const parentID of parentIDs) {
      for (let i = 0; i < cv._rows.length; i++) {
        const row = cv._rows[i];
        if (row.ref?.id === parentID) {
          if (cv.isContainer(i) && !cv.isContainerOpen(i)) cv.toggleOpenState(i, true);
          break;
        }
      }
    }
  } catch (e) {
    ztoolkit.log(`expandParentCollections error: ${e}`);
  }
}

function setupNavStripWidthTracking(doc: Document, strip: HTMLElement) {
  const win = doc.defaultView;
  const schedule = (() => {
    let pending = false;
    const run = () => {
      pending = false;
      updateNavStripWidth(doc, strip);
      refreshBreadcrumbOverflow(doc);
    };
    return () => {
      if (pending) return;
      pending = true;
      if (win?.requestAnimationFrame) {
        win.requestAnimationFrame(run);
      } else {
        setTimeout(run, 0);
      }
    };
  })();

  schedule();

  const cleanupFns: Array<() => void> = [];

  if (win?.ResizeObserver) {
    const observer = new win.ResizeObserver(() => schedule());
    const observed = new Set<HTMLElement>();
    const maybeObserve = (el: HTMLElement | null) => {
      if (el && !observed.has(el)) {
        observer.observe(el);
        observed.add(el);
      }
    };
    maybeObserve(doc.getElementById("zotero-items-pane") as HTMLElement | null);
    maybeObserve(doc.getElementById("zotero-items-pane-container") as HTMLElement | null);
    maybeObserve(doc.getElementById("zotero-layout-switcher") as HTMLElement | null);
    if (observed.size) {
      cleanupFns.push(() => observer.disconnect());
    }
  }

  if (win) {
    const handler = () => schedule();
    win.addEventListener("resize", handler);
    cleanupFns.push(() => win.removeEventListener("resize", handler));
  }

  if (!cleanupFns.length) {
    return () => { };
  }
  return () => {
    cleanupFns.splice(0).forEach(fn => {
      try {
        fn();
      } catch { }
    });
  };
}

function updateNavStripWidth(doc: Document, strip?: HTMLElement | null) {
  const nav = strip ?? (doc.getElementById("thiago-nav-strip") as HTMLElement | null);
  if (!nav) return;
  const hostRect = getNavHostRect(doc);
  if (hostRect && hostRect.width > 0) {
    nav.style.maxWidth = `${hostRect.width}px`;
    nav.style.width = "100%";
  } else {
    nav.style.maxWidth = "";
    nav.style.width = "100%";
  }
}

function getNavHostRect(doc: Document): DOMRect | null {
  const itemsPane = doc.getElementById("zotero-items-pane") as HTMLElement | null;
  if (itemsPane) {
    const rect = itemsPane.getBoundingClientRect();
    if (rect.width) return rect;
  }
  const fallback = doc.getElementById("zotero-items-pane-container") as HTMLElement | null;
  return fallback?.getBoundingClientRect() ?? null;
}

function refreshBreadcrumbOverflow(doc: Document) {
  const crumbs = doc.getElementById("thiago-nav-breadcrumbs") as HTMLElement | null;
  if (!crumbs || crumbs.style.display === "none" || !crumbs.isConnected) return;
  closeBreadcrumbOverflowMenu();
  removeBreadcrumbEllipsis(crumbs);
  const nodes = collectBreadcrumbNodesFromDOM(doc, crumbs);
  if (!nodes.length) return;
  nodes.forEach(node => {
    node.crumb.style.display = "";
    if (node.separator) node.separator.style.display = "";
  });
  scheduleBreadcrumbOverflowMeasurement(doc, crumbs, nodes);
}

function removeBreadcrumbEllipsis(crumbsEl: HTMLElement) {
  const toRemove = crumbsEl.querySelectorAll(".thiago-crumb-ellipsis, .thiago-crumb-ellipsis-sep");
  toRemove.forEach(el => {
    if (el.parentElement === crumbsEl) {
      el.remove();
    }
  });
}

function collectBreadcrumbNodesFromDOM(doc: Document, crumbsEl: HTMLElement): BreadcrumbNode[] {
  const nodes: BreadcrumbNode[] = [];
  let child = crumbsEl.firstElementChild;
  while (child) {
    if (
      child.classList.contains("thiago-crumb") &&
      !child.classList.contains("thiago-crumb-ellipsis")
    ) {
      const crumb = child as HTMLSpanElement;
      const prev = crumb.previousElementSibling;
      const separator =
        prev && prev.classList.contains("thiago-crumb-sep") ? (prev as HTMLSpanElement) : null;
      const label = crumb.getAttribute("data-thiago-label") || crumb.textContent || "";
      const collectionAttr = crumb.getAttribute("data-thiago-collection-id");
      const seg: PathSeg = {
        label,
        collectionID: collectionAttr && collectionAttr.length ? Number(collectionAttr) : null,
      };
      nodes.push({ seg, crumb, separator });
    }
    child = child.nextElementSibling;
  }
  return nodes;
}

function scheduleBreadcrumbOverflowMeasurement(
  doc: Document,
  crumbsEl: HTMLElement,
  nodes: BreadcrumbNode[],
) {
  if (!nodes.length) return;
  const runner = () => {
    if (!crumbsEl.isConnected) return;
    applyBreadcrumbOverflow(doc, crumbsEl, nodes);
  };
  const win = doc.defaultView;
  if (win?.requestAnimationFrame) {
    win.requestAnimationFrame(runner);
  } else {
    setTimeout(runner, 0);
  }
}

function applyBreadcrumbOverflow(
  doc: Document,
  crumbsEl: HTMLElement,
  nodes: BreadcrumbNode[],
) {
  const containerWidth = getBreadcrumbAvailableWidth(doc, crumbsEl);
  if (!containerWidth) {
    crumbsEl.style.maxWidth = "";
    return;
  }
  crumbsEl.style.maxWidth = `${containerWidth}px`;
  const hidden: BreadcrumbNode[] = [];
  const isOverflowing = () => crumbsEl.scrollWidth > containerWidth + 1;
  if (!isOverflowing()) return;
  for (let i = 0; i < nodes.length - 1 && isOverflowing(); i++) {
    const node = nodes[i];
    hidden.push(node);
    node.crumb.style.display = "none";
    if (node.separator) node.separator.style.display = "none";
    const next = nodes[i + 1];
    if (next?.separator) next.separator.style.display = "none";
  }
  if (!hidden.length) return;
  insertBreadcrumbEllipsis(doc, crumbsEl, hidden.map(n => n.seg));
}

function getBreadcrumbAvailableWidth(doc: Document, crumbsEl: HTMLElement) {
  const hostRect = getNavHostRect(doc);
  if (hostRect) {
    const crumbsRect = crumbsEl.getBoundingClientRect();
    const available = hostRect.right - crumbsRect.left - 4;
    if (available > 0) {
      return available;
    }
  }
  return crumbsEl.clientWidth || crumbsEl.getBoundingClientRect().width || 0;
}

function insertBreadcrumbEllipsis(doc: Document, crumbsEl: HTMLElement, segments: PathSeg[]) {
  if (!segments.length) return;
  const ellipsis = doc.createElement("span");
  ellipsis.className = "thiago-crumb thiago-crumb-ellipsis";
  ellipsis.textContent = "\u2026";
  ellipsis.title = segments.map(seg => seg.label).join(" > ");
  ellipsis.tabIndex = 0;
  ellipsis.setAttribute("role", "button");
  const activate = () => toggleBreadcrumbOverflowMenu(ellipsis, segments);
  ellipsis.addEventListener("click", ev => {
    ev.preventDefault();
    ev.stopPropagation();
    activate();
  });
  ellipsis.addEventListener("keydown", ev => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      activate();
    }
  });
  const sep = doc.createElement("span");
  sep.className = "thiago-crumb-sep thiago-crumb-ellipsis-sep";
  sep.textContent = ">";
  crumbsEl.prepend(sep);
  crumbsEl.prepend(ellipsis);
}

function toggleBreadcrumbOverflowMenu(target: HTMLElement, segments: PathSeg[]) {
  if (navOverflowMenuAnchor === target) {
    closeBreadcrumbOverflowMenu();
  } else {
    openBreadcrumbOverflowMenu(target, segments);
  }
}

function openBreadcrumbOverflowMenu(target: HTMLElement, segments: PathSeg[]) {
  closeBreadcrumbOverflowMenu();
  const doc = target.ownerDocument;
  if (!doc) return;
  const host = doc.body || doc.documentElement;
  if (!host) return;
  const menu = doc.createElement("div");
  menu.id = "thiago-nav-overflow-menu";
  menu.className = "thiago-nav-overflow-menu";
  menu.setAttribute("role", "menu");
  menu.tabIndex = -1;
  segments.forEach(seg => {
    const item = doc.createElement("button");
    item.className = "thiago-nav-menu-item";
    item.type = "button";
    item.textContent = seg.label;
    item.title = seg.label;
    item.setAttribute("role", "menuitem");
    if (seg.collectionID == null) {
      item.disabled = true;
    } else {
      const targetID = seg.collectionID;
      item.addEventListener("click", () => {
        closeBreadcrumbOverflowMenu();
        navigateToCollection(targetID);
        deps.scheduleRerender(120);
      });
    }
    menu.appendChild(item);
  });
  if (!menu.childElementCount) {
    menu.remove();
    return;
  }
  host.appendChild(menu);
  const rect = target.getBoundingClientRect();
  const menuRect = menu.getBoundingClientRect();
  const win = doc.defaultView;
  const viewportWidth =
    win?.innerWidth ??
    doc.documentElement?.clientWidth ??
    host.clientWidth ??
    menuRect.width;
  const viewportHeight =
    win?.innerHeight ??
    doc.documentElement?.clientHeight ??
    host.clientHeight ??
    menuRect.height;
  let left = rect.left;
  let top = rect.bottom + 4;
  if (left + menuRect.width > viewportWidth - 8) {
    left = Math.max(8, viewportWidth - menuRect.width - 8);
  }
  if (top + menuRect.height > viewportHeight - 8) {
    top = Math.max(8, rect.top - menuRect.height - 4);
  }
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  const handlePointer = (ev: MouseEvent) => {
    const node = ev.target as Node | null;
    if (node && (menu.contains(node) || target.contains(node))) return;
    closeBreadcrumbOverflowMenu();
  };
  const handleKey = (ev: KeyboardEvent) => {
    if (ev.key === "Escape") {
      ev.preventDefault();
      closeBreadcrumbOverflowMenu();
    }
  };
  doc.addEventListener("mousedown", handlePointer, true);
  doc.addEventListener("contextmenu", handlePointer, true);
  doc.addEventListener("keydown", handleKey, true);
  navOverflowMenuCleanup = () => {
    try {
      menu.remove();
    } catch { }
    doc.removeEventListener("mousedown", handlePointer, true);
    doc.removeEventListener("contextmenu", handlePointer, true);
    doc.removeEventListener("keydown", handleKey, true);
    target.classList.remove("thiago-nav-menu-open");
    navOverflowMenuAnchor = null;
  };
  navOverflowMenuAnchor = target;
  target.classList.add("thiago-nav-menu-open");
}

function closeBreadcrumbOverflowMenu() {
  if (navOverflowMenuCleanup) {
    try {
      navOverflowMenuCleanup();
    } catch { }
    navOverflowMenuCleanup = null;
    navOverflowMenuAnchor = null;
  }
}

function removeNavStrip(doc?: Document) {
  const documentRef = doc ?? (() => {
    try {
      return getDocument();
    } catch {
      return null;
    }
  })();
  if (!documentRef) return;
  closeBreadcrumbOverflowMenu();
  const strip = documentRef.getElementById("thiago-nav-strip");
  if (strip) {
    try {
      strip.remove();
    } catch { }
  }
  if (navStripCleanup) {
    try {
      navStripCleanup();
    } catch { }
    navStripCleanup = null;
  }
}
