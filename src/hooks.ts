import { debugCurrentState, scheduleRerender, setupCollectionChangeListener, teardownCollectionChangeListener, shutdownFolderRows } from "./folderRows";
import { configureNavigation, isNavStripEnabled, setNavStripEnabled } from "./navigation";

/**
 * Clean build:
 * - No top "bar" UI at all.
 * - Only folder-like rows injected at top of the items list.
 * - Debounced re-render on collection changes for stability.
 */
class Hooks {
  static async onStartup() {
    const ADDON_NAME = "Zotero File Explorer";
    ztoolkit.log("Plugin starting...");

    await Zotero.uiReadyPromise;
    ztoolkit.log("UI ready");

    const toggleNavMenuId = "zotero-plugin-toggle-nav-strip";
    const getToggleNavLabel = () =>
      isNavStripEnabled() ? "Disable Navigation Bar" : "Enable Navigation Bar";
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
