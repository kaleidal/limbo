import { useState } from "react";
import { Loader2, RefreshCw, Share2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { commands, type Settings } from "@/lib/bindings";
import { useAppStore } from "@/store/app-store";
import { NetworkDevices } from "./network-devices";
import { Row, Section, ToggleRow } from "./section";

const DEFAULT_API_PORT = 17890;

export function TorrentSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const [rotating, setRotating] = useState(false);
  const [rotation, setRotation] = useState<"rotated" | "error" | null>(null);

  const rotateToken = async () => {
    setRotating(true);
    setRotation(null);
    try {
      await commands.settingsRotateApiToken();
      useAppStore.getState().setSettings(await commands.settingsGet());
      setRotation("rotated");
    } catch {
      setRotation("error");
    } finally {
      setRotating(false);
    }
  };

  return (
    <Section icon={<Share2 className="w-5 h-5" />} title="Torrents">
      <ToggleRow
        title="Keep seeding"
        description="Keep uploading finished torrents. Turn off to stop sharing as soon as a download completes."
        checked={settings.enableSeeding}
        onChange={(enableSeeding) => update({ enableSeeding })}
      />
      <ToggleRow
        title="Require a VPN"
        description="Check interface names when adding a torrent. This is not a routing check or kill switch, and IPv6-only VPN interfaces may not be detected."
        checked={settings.requireVpn}
        onChange={(requireVpn) => update({ requireVpn })}
      />
      <ToggleRow
        title="Watch the clipboard"
        description="Offer to download links and magnets you copy while Limbo is open."
        checked={settings.clipboardMonitoring}
        onChange={(clipboardMonitoring) => update({ clipboardMonitoring })}
      />
      <ToggleRow
        title="Companion API"
        description="Let companion apps like Raffi add and stream Limbo torrents."
        checked={settings.apiEnabled}
        onChange={(apiEnabled) => update({ apiEnabled })}
      />
      {settings.apiEnabled && (
        <>
          <div>
            <Label htmlFor="apiPort">API port</Label>
            <Input
              id="apiPort"
              type="number"
              min={1}
              max={65535}
              value={settings.apiPort}
              onChange={(event) => update({ apiPort: parseInt(event.target.value) || DEFAULT_API_PORT })}
              className="bg-neutral-800 border-neutral-700 mt-1 w-32"
            />
            <p className="text-xs text-neutral-500 mt-1">
              Companion apps find the address and access token in Limbo&apos;s api.json.
            </p>
          </div>
          <Row
            title="Access token"
            description={
              rotation === "rotated" ? (
                <span className="text-emerald-400">Token rotated.</span>
              ) : rotation === "error" ? (
                <span className="text-red-400">Couldn&apos;t rotate the token.</span>
              ) : (
                "Rotate the token to cut off companion apps that already have it."
              )
            }
          >
            <Button type="button" variant="outline" onClick={rotateToken} disabled={rotating}>
              {rotating ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Rotate
            </Button>
          </Row>
          <div className="border-t border-neutral-800 pt-4">
            <ToggleRow
              title="Ask before adding torrents"
              description="Show an approval prompt when a companion app asks for a torrent."
              checked={settings.apiPromptPolicy === "always"}
              onChange={(ask) => update({ apiPromptPolicy: ask ? "always" : "off" })}
            />
          </div>
          <NetworkDevices settings={settings} update={update} />
          {settings.trustedApiClients.length > 0 && (
            <div className="border-t border-neutral-800 pt-4">
              <p className="font-medium">Trusted apps</p>
              <p className="mt-1 text-sm text-neutral-500">
                These programs can add torrents without asking first.
              </p>
              <div className="mt-3 divide-y divide-neutral-800">
                {settings.trustedApiClients.map((trustKey) => (
                  <div key={trustKey} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                    <span className="min-w-0 flex-1 break-all font-mono text-xs text-neutral-300">
                      {trustKey.replace(/^exe:/, "")}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      title="Revoke trust"
                      className="shrink-0 text-neutral-500 hover:text-red-400 active:scale-[0.96]"
                      onClick={() =>
                        update({
                          trustedApiClients: settings.trustedApiClients.filter((key) => key !== trustKey),
                        })
                      }
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </Section>
  );
}
