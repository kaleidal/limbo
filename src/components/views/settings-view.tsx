import { useState, useEffect } from "react";
import { useAppStore } from "@/store/app-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Folder,
  Download,
  Key,
  Server,
  Save,
  RefreshCw,
  Globe,
  RotateCcw,
  Monitor,
  Share2,
  Power,
} from "lucide-react";

export function SettingsView() {
  const { settings, setSettings } = useAppStore();
  const [localSettings, setLocalSettings] = useState(settings);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  const handleSelectPath = async () => {
    if (window.limbo) {
      const path = await window.limbo.selectDownloadPath();
      if (path && localSettings) {
        setLocalSettings({ ...localSettings, downloadPath: path });
      }
    }
  };

  const handleSave = async () => {
    if (window.limbo && localSettings) {
      const updated = await window.limbo.updateSettings(localSettings);
      setSettings(updated);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    }
  };

  if (!localSettings) {
    return (
      <div className="h-full flex items-center justify-center">
        <RefreshCw className="w-8 h-8 animate-spin text-neutral-500" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-6">
      <div className="max-w-2xl mx-auto">
        <h1 className="text-2xl font-bold mb-6">Settings</h1>

        {/* Download Settings */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Download className="w-5 h-5" />
            Download Settings
          </h2>
          <div className="space-y-4 bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div>
              <Label htmlFor="downloadPath">Download Location</Label>
              <div className="flex gap-2 mt-1">
                <Input
                  id="downloadPath"
                  value={localSettings.downloadPath}
                  onChange={(e) =>
                    setLocalSettings({
                      ...localSettings,
                      downloadPath: e.target.value,
                    })
                  }
                  className="bg-neutral-800 border-neutral-700"
                />
                <Button variant="outline" onClick={handleSelectPath}>
                  <Folder className="w-4 h-4" />
                </Button>
              </div>
            </div>

            <div>
              <Label htmlFor="maxConcurrent">Max Concurrent Downloads</Label>
              <Input
                id="maxConcurrent"
                type="number"
                min={1}
                max={10}
                value={localSettings.maxConcurrentDownloads}
                onChange={(e) =>
                  setLocalSettings({
                    ...localSettings,
                    maxConcurrentDownloads: parseInt(e.target.value) || 3,
                  })
                }
                className="bg-neutral-800 border-neutral-700 mt-1 w-32"
              />
            </div>
          </div>
        </section>

        {/* Torrent Settings */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Share2 className="w-5 h-5" />
            Torrent Settings
          </h2>
          <div className="space-y-4 bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Enable Seeding</p>
                <p className="text-sm text-neutral-500">
                  Continue uploading after download completes. Disable to stop sharing immediately.
                </p>
              </div>
              <Switch
                checked={localSettings.enableSeeding}
                onCheckedChange={(checked: boolean) =>
                  setLocalSettings({
                    ...localSettings,
                    enableSeeding: checked,
                  })
                }
              />
            </div>
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Require VPN for Torrents</p>
                <p className="text-sm text-neutral-500">
                  Block torrent downloads when no VPN is detected. Helps protect your privacy.
                </p>
              </div>
              <Switch
                checked={localSettings.requireVpn}
                onCheckedChange={(checked: boolean) =>
                  setLocalSettings({
                    ...localSettings,
                    requireVpn: checked,
                  })
                }
              />
            </div>
          </div>
        </section>

        {/* Debrid Settings */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Server className="w-5 h-5" />
            Debrid Service
          </h2>
          <div className="space-y-4 bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div>
              <Label>Service Provider</Label>
              <div className="flex gap-2 mt-1">
                {(["realdebrid", "alldebrid", "premiumize"] as const).map(
                  (service) => (
                    <Button
                      key={service}
                      variant={
                        localSettings.debrid.service === service
                          ? "default"
                          : "outline"
                      }
                      size="sm"
                      onClick={() =>
                        setLocalSettings({
                          ...localSettings,
                          debrid: { ...localSettings.debrid, service },
                        })
                      }
                    >
                      {service === "realdebrid" && "Real-Debrid"}
                      {service === "alldebrid" && "AllDebrid"}
                      {service === "premiumize" && "Premiumize"}
                    </Button>
                  )
                )}
                <Button
                  variant={
                    localSettings.debrid.service === null ? "default" : "outline"
                  }
                  size="sm"
                  onClick={() =>
                    setLocalSettings({
                      ...localSettings,
                      debrid: { ...localSettings.debrid, service: null },
                    })
                  }
                >
                  None
                </Button>
              </div>
            </div>

            {localSettings.debrid.service && (
              <div>
                <Label htmlFor="apiKey">API Key</Label>
                <div className="relative mt-1">
                  <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
                  <Input
                    id="apiKey"
                    type="password"
                    value={localSettings.debrid.apiKey}
                    onChange={(e) =>
                      setLocalSettings({
                        ...localSettings,
                        debrid: {
                          ...localSettings.debrid,
                          apiKey: e.target.value,
                        },
                      })
                    }
                    placeholder="Enter your API key..."
                    className="pl-10 bg-neutral-800 border-neutral-700"
                  />
                </div>
                <p className="text-xs text-neutral-500 mt-1">
                  {localSettings.debrid.service === "realdebrid" &&
                    "Get your API key from real-debrid.com/apitoken"}
                  {localSettings.debrid.service === "alldebrid" &&
                    "Get your API key from alldebrid.com/apikeys"}
                  {localSettings.debrid.service === "premiumize" &&
                    "Get your API key from premiumize.me/account"}
                </p>
              </div>
            )}
          </div>
        </section>

        {/* Bookmarks Settings */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Globe className="w-5 h-5" />
            Bookmarks
          </h2>
          <div className="space-y-4 bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Reset Bookmarks</p>
                <p className="text-sm text-neutral-500">
                  Restore default bookmark (Internet Archive)
                </p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (window.limbo) {
                    const bookmarks = await window.limbo.resetBookmarks();
                    useAppStore.getState().setBookmarks(bookmarks);
                  }
                }}
                className="gap-2"
              >
                <RotateCcw className="w-4 h-4" />
                Reset
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Import Bookmarks</p>
                <p className="text-sm text-neutral-500">Load bookmarks from a JSON file</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!window.limbo) return;
                  const bookmarks = await window.limbo.importBookmarks();
                  if (bookmarks) useAppStore.getState().setBookmarks(bookmarks);
                }}
              >
                Import
              </Button>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Export Bookmarks</p>
                <p className="text-sm text-neutral-500">Save your bookmarks as a JSON file</p>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  if (!window.limbo) return;
                  await window.limbo.exportBookmarks();
                }}
              >
                Export
              </Button>
            </div>
          </div>
        </section>

        {/* Performance Settings */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Monitor className="w-5 h-5" />
            Performance
          </h2>
          <div className="space-y-4 bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Hardware Acceleration</p>
                <p className="text-sm text-neutral-500">
                  Use GPU for rendering. Disable if you see visual artifacts or lines on screen.
                </p>
              </div>
              <Switch
                checked={localSettings.hardwareAcceleration}
                onCheckedChange={(checked: boolean) =>
                  setLocalSettings({
                    ...localSettings,
                    hardwareAcceleration: checked,
                  })
                }
              />
            </div>
            <p className="text-xs text-amber-500">
              ⚠️ Requires app restart to take effect
            </p>
          </div>
        </section>

        {/* Startup Settings */}
        <section className="mb-8">
          <h2 className="text-lg font-semibold mb-4 flex items-center gap-2">
            <Power className="w-5 h-5" />
            Startup
          </h2>
          <div className="space-y-4 bg-neutral-900 rounded-lg p-4 border border-neutral-800">
            <div className="flex items-center justify-between">
              <div>
                <p className="font-medium">Start on Boot</p>
                <p className="text-sm text-neutral-500">
                  Automatically launch Limbo when your computer starts.
                </p>
              </div>
              <Switch
                checked={localSettings.startOnBoot}
                onCheckedChange={(checked: boolean) =>
                  setLocalSettings({
                    ...localSettings,
                    startOnBoot: checked,
                  })
                }
              />
            </div>
          </div>
        </section>

        {/* Save button */}
        <div className="flex justify-end">
          <Button onClick={handleSave} className="gap-2">
            <Save className="w-4 h-4" />
            {saved ? "Saved!" : "Save Settings"}
          </Button>
        </div>
      </div>
    </div>
  );
}
