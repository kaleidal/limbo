import { useEffect, useRef, useState } from "react";
import { Link2, Loader2, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commands, events, type DeviceSummary, type Settings } from "@/lib/bindings";
import { Row, ToggleRow } from "./section";

type ActiveCode = { code: string; expiresAt: number };

function formatRemaining(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function PairingCode({ active, onCancel }: { active: ActiveCode; onCancel: () => void }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (now >= active.expiresAt) onCancel();
  }, [now, active.expiresAt, onCancel]);

  return (
    <div className="flex items-center justify-between gap-4 rounded-md bg-neutral-800/60 px-4 py-3">
      <div>
        <p className="font-mono text-3xl font-semibold tracking-[0.3em] text-neutral-100 tabular-nums">
          {active.code}
        </p>
        <p className="mt-1 text-sm text-neutral-500">
          Enter this code on your device. It expires in {formatRemaining(active.expiresAt - now)}.
        </p>
      </div>
      <Button type="button" variant="ghost" size="icon" title="Stop pairing" onClick={onCancel}>
        <X className="size-4" />
      </Button>
    </div>
  );
}

export function NetworkDevices({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const [devices, setDevices] = useState<DeviceSummary[]>([]);
  const [active, setActive] = useState<ActiveCode | null>(null);
  const [starting, setStarting] = useState(false);
  const [failed, setFailed] = useState(false);
  const deviceCount = useRef(0);

  useEffect(() => {
    void commands.devicesList().then((list) => {
      deviceCount.current = list.length;
      setDevices(list);
    });
    return events.devicesUpdated((list) => {
      if (list.length > deviceCount.current) setActive(null);
      deviceCount.current = list.length;
      setDevices(list);
    });
  }, []);

  useEffect(() => {
    if (!active) return;
    return () => void commands.devicesStopPairing();
  }, [active]);

  const startPairing = async () => {
    setStarting(true);
    setFailed(false);
    try {
      const pairing = await commands.devicesStartPairing();
      setActive({ code: pairing.code, expiresAt: Date.now() + pairing.expiresInSeconds * 1000 });
    } catch {
      setFailed(true);
    } finally {
      setStarting(false);
    }
  };

  return (
    <div className="border-t border-neutral-800 pt-4 space-y-4">
      <ToggleRow
        title="Devices on your network"
        description="Let Raffi on your TV and other devices on this network find Limbo and stream torrents from it."
        checked={settings.apiLanEnabled}
        onChange={(apiLanEnabled) => update({ apiLanEnabled })}
      />
      {settings.apiLanEnabled && (
        <>
          {active ? (
            <PairingCode active={active} onCancel={() => setActive(null)} />
          ) : (
            <Row
              title="Pair a device"
              description={
                failed ? (
                  <span className="text-red-400">Couldn&apos;t start pairing.</span>
                ) : (
                  "Paired devices can add and stream torrents without asking first."
                )
              }
            >
              <Button type="button" variant="outline" onClick={startPairing} disabled={starting}>
                {starting ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                Pair
              </Button>
            </Row>
          )}
          {devices.length > 0 && (
            <div className="divide-y divide-neutral-800">
              {devices.map((device) => (
                <div key={device.id} className="flex items-center gap-3 py-2 first:pt-0 last:pb-0">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-neutral-200">{device.name}</p>
                    <p className="text-xs text-neutral-500">
                      Paired {new Date(device.pairedAt).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    title="Unpair"
                    className="shrink-0 text-neutral-500 hover:text-red-400 active:scale-[0.96]"
                    onClick={() => void commands.devicesUnpair({ id: device.id })}
                  >
                    <Trash2 className="size-4" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
