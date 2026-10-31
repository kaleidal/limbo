import { useEffect, useState } from "react";
import { RefreshCw, Save } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commands, type Settings } from "@/lib/bindings";
import { useAppStore } from "@/store/app-store";
import { DebridSection } from "./debrid-section";
import { DownloadSection } from "./download-section";
import { BookmarksSection, DataSection, StartupSection } from "./general-sections";
import { TorrentSection } from "./torrent-section";

export function SettingsView() {
  const settings = useAppStore((state) => state.settings);
  const [draft, setDraft] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setDraft(settings);
  }, [settings]);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), 2000);
    return () => window.clearTimeout(timer);
  }, [saved]);

  if (!draft) {
    return (
      <div className="h-full flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-neutral-500" />
      </div>
    );
  }

  const update = (patch: Partial<Settings>) => setDraft({ ...draft, ...patch });

  const save = async () => {
    useAppStore.getState().setSettings(await commands.settingsUpdate(draft));
    setSaved(true);
  };

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>
        <DownloadSection settings={draft} update={update} />
        <TorrentSection settings={draft} update={update} />
        <DebridSection settings={draft} update={update} />
        <BookmarksSection />
        <StartupSection settings={draft} update={update} />
        <DataSection />
        <div className="flex justify-end">
          <Button onClick={save} className="gap-2">
            <Save className="w-4 h-4" />
            {saved ? "Saved" : "Save settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}
