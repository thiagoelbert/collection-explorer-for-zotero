import { debugCurrentState, scheduleRerender, setupCollectionChangeListener, teardownCollectionChangeListener, shutdownFolderRows } from "./folderRows";
import { configureNavigation, isNavStripEnabled, setNavStripEnabled } from "./navigation";
import { getString, initLocale } from "./utils/locale";

/**
 * Clean build:
 * - No top "bar" UI at all.
 * - Only folder-like rows injected at top of the items list.
 * - Debounced re-render on collection changes for stability.
 */
// Orchestrates addon lifecycle hooks that Zotero calls.
class Hooks {
  /**
   * Entry point for the addon: waits for the UI, wires menu items, boots folder rows.
   */
  static async onStartup() {
    const ADDON_NAME = "Zotero File Explorer";
    ztoolkit.log("Plugin starting...");

    await Zotero.uiReadyPromise;
    ztoolkit.log("UI ready");
    initLocale();

    const toggleNavMenuId = "zotero-plugin-toggle-nav-strip";
    const getToggleNavLabel = () =>
      getString("nav-strip-toggle", {
        branch: isNavStripEnabled() ? "disable" : "enable",
      });
    const refreshToggleNavLabel = () => {
      try {
        const doc = Zotero.getMainWindow()?.document;
        const el = doc?.getElementById(toggleNavMenuId);
        if (el) el.setAttribute("label", getToggleNavLabel());
      } catch { }
    };

    ztoolkit.Menu.register("menuTools", {
      tag: "menuitem",
      id: toggleNavMenuId,
      label: getToggleNavLabel(),
      commandListener: () => {
        setNavStripEnabled(!isNavStripEnabled());
        refreshToggleNavLabel();
      },
    });
    Zotero.Promise.delay(0).then(refreshToggleNavLabel).catch(() => { });

    await Zotero.Promise.delay(400);
    scheduleRerender(10);
    setupCollectionChangeListener();
  }

  /**
   * Ensures every injected listener/observer is released when the addon unloads.
   */
  static onShutdown(): void {
    ztoolkit.unregisterAll();
    shutdownFolderRows();
    teardownCollectionChangeListener();
  }

  static onMainWindowLoad(): void { }
  static onMainWindowUnload(): void { }
  static async onDialogLaunch() { }
}

configureNavigation({ scheduleRerender });

export default Hooks;
