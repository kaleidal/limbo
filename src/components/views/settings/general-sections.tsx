import { useState } from "react";
import { Globe, Loader2, Power, RotateCcw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog";
import { commands, type Settings } from "@/lib/bindings";
import { useAppStore } from "@/store/app-store";
import { Row, Section, ToggleRow } from "./section";

export function BookmarksSection() {
  const setBookmarks = useAppStore((state) => state.setBookmarks);

  return (
    <Section icon={<Globe className="w-5 h-5" />} title="Bookmarks">
      <Row title="Reset bookmarks" description="Go back to the default bookmark, the Internet Archive.">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => setBookmarks(await commands.bookmarksReset())}
          className="gap-2"
        >
          <RotateCcw className="w-4 h-4" />
          Reset
        </Button>
      </Row>
      <Row title="Import bookmarks" description="Load bookmarks from a JSON file.">
        <Button
          variant="outline"
          size="sm"
          onClick={async () => {
            const bookmarks = await commands.bookmarksImport();
            if (bookmarks) setBookmarks(bookmarks);
          }}
        >
          Import
        </Button>
      </Row>
      <Row title="Export bookmarks" description="Save your bookmarks as a JSON file.">
        <Button variant="outline" size="sm" onClick={() => commands.bookmarksExport()}>
          Export
        </Button>
      </Row>
    </Section>
  );
}

export function StartupSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  return (
    <Section icon={<Power className="w-5 h-5" />} title="Startup">
      <ToggleRow
        title="Open at login"
        description="Start Limbo when you sign in. Takes effect the next time Limbo starts."
        checked={settings.startOnBoot}
        onChange={(startOnBoot) => update({ startOnBoot })}
      />
    </Section>
  );
}

export function DataSection() {
  const [confirming, setConfirming] = useState(false);
  const [clearing, setClearing] = useState(false);

  const clear = async () => {
    setConfirming(false);
    setClearing(true);
    try {
      const cleared = await commands.settingsClearData();
      const store = useAppStore.getState();
      store.setDownloads(cleared.downloads);
      store.setTorrents(cleared.torrents);
      store.setLibrary(cleared.library);
      store.setSettings(cleared.settings);
    } catch (error) {
      console.error("Failed to clear data:", error);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Section icon={<Trash2 className="w-5 h-5" />} title="Data">
      <Row
        title="Clear all data"
        description="Forget every download, torrent and library item and reset settings. Bookmarks, the download location and downloaded files stay."
      >
        <Button
          variant="destructive"
          size="sm"
          onClick={() => setConfirming(true)}
          disabled={clearing}
          className="gap-2 shrink-0"
        >
          {clearing ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
          {clearing ? "Clearing..." : "Clear data"}
        </Button>
      </Row>
      <ConfirmDialog
        open={confirming}
        title="Clear all data?"
        description="This can't be undone. Files you downloaded stay on disk."
        confirmLabel="Clear data"
        onConfirm={clear}
        onCancel={() => setConfirming(false)}
      />
    </Section>
  );
}
