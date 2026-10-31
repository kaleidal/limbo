import { Download, Folder } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { commands, type Settings } from "@/lib/bindings";
import { Section, ToggleRow } from "./section";

export function DownloadSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const selectPath = async () => {
    const path = await commands.settingsSelectDownloadPath();
    if (path) update({ downloadPath: path });
  };

  return (
    <Section icon={<Download className="w-5 h-5" />} title="Downloads">
      <div>
        <Label htmlFor="downloadPath">Download location</Label>
        <div className="flex gap-2 mt-1">
          <Input
            id="downloadPath"
            value={settings.downloadPath}
            onChange={(event) => update({ downloadPath: event.target.value })}
            className="bg-neutral-800 border-neutral-700"
          />
          <Button variant="outline" onClick={selectPath}>
            <Folder className="w-4 h-4" />
          </Button>
        </div>
      </div>

      <div>
        <Label htmlFor="maxConcurrent">Downloads at once</Label>
        <Input
          id="maxConcurrent"
          type="number"
          min={1}
          max={10}
          value={settings.maxConcurrentDownloads}
          onChange={(event) =>
            update({ maxConcurrentDownloads: Math.min(10, Math.max(1, parseInt(event.target.value) || 3)) })
          }
          className="bg-neutral-800 border-neutral-700 mt-1 w-32"
        />
        <p className="text-xs text-neutral-500 mt-1">Further downloads wait in the queue.</p>
      </div>

      <ToggleRow
        title="Extract archives"
        description="Unpack zip, 7z and rar downloads once every part has arrived."
        checked={settings.autoExtract}
        onChange={(autoExtract) => update({ autoExtract })}
      />
      {settings.autoExtract && (
        <ToggleRow
          title="Delete archives after extracting"
          description="Remove the archive files once their contents are unpacked."
          checked={settings.deleteArchiveAfterExtract}
          onChange={(deleteArchiveAfterExtract) => update({ deleteArchiveAfterExtract })}
        />
      )}
    </Section>
  );
}
