import { useCallback, useEffect, useRef, useState } from "react";
import { AlertCircle, CheckCircle, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { commands, type RdDeviceStart } from "@/lib/bindings";
import { useAppStore } from "@/store/app-store";

export function RealDebridLink({
  linked,
  showApiKey,
  onShowApiKeyChange,
  onUnlink,
}: {
  linked: boolean;
  showApiKey: boolean;
  onShowApiKeyChange: (show: boolean) => void;
  onUnlink: () => void;
}) {
  const [device, setDevice] = useState<RdDeviceStart | null>(null);
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollTimer = useRef<number | null>(null);
  const pollGeneration = useRef(0);

  const stopPolling = useCallback(() => {
    pollGeneration.current += 1;
    if (pollTimer.current !== null) window.clearTimeout(pollTimer.current);
    pollTimer.current = null;
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const finish = (message: string | null) => {
    stopPolling();
    setLinking(false);
    setError(message);
  };

  const startLink = async () => {
    setError(null);
    setLinking(true);
    onShowApiKeyChange(false);
    let started: RdDeviceStart;
    try {
      started = await commands.debridRealDebridLinkStart();
    } catch {
      finish("Real-Debrid: failed to start device linking");
      return;
    }
    setDevice(started);
    stopPolling();
    const generation = pollGeneration.current;
    const interval = Math.max(1, started.interval) * 1_000;
    const poll = async () => {
      try {
        const result = await commands.debridRealDebridLinkPoll();
        if (pollGeneration.current !== generation) return;
        switch (result.status) {
          case "idle":
          case "pending":
            pollTimer.current = window.setTimeout(poll, interval);
            return;
          case "linked":
            finish(null);
            setDevice(null);
            useAppStore.getState().setSettings(await commands.settingsGet());
            return;
          case "expired":
          case "error":
            finish(result.error);
        }
      } catch {
        if (pollGeneration.current === generation) finish("Real-Debrid: polling failed");
      }
    };
    pollTimer.current = window.setTimeout(poll, interval);
  };

  const cancelLink = async () => {
    stopPolling();
    try {
      await commands.debridRealDebridLinkCancel();
    } finally {
      setDevice(null);
      setLinking(false);
    }
  };

  const openVerification = async (url: string) => {
    try {
      await commands.appOpenExternal({ url });
    } catch {
      setError("Couldn't open the browser");
    }
  };

  return (
    <div className="pt-2 border-t border-neutral-700">
      <Label>Real-Debrid device link</Label>
      <p className="text-sm text-neutral-500 mt-1">
        Link your Real-Debrid account without copying an API token by hand.
      </p>

      {error && (
        <div className="flex items-center gap-2 text-red-400 text-sm mt-2">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      )}

      {device ? (
        <div className="mt-3 space-y-2">
          <div>
            <Label htmlFor="rdUserCode">Code</Label>
            <Input
              id="rdUserCode"
              value={device.userCode}
              readOnly
              className="mt-1 bg-neutral-800 border-neutral-700"
            />
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => openVerification(device.verificationUrl)}>
              Open real-debrid.com/device
            </Button>
            <Button variant="ghost" size="sm" onClick={cancelLink}>
              Cancel
            </Button>
            {linking && (
              <div className="flex items-center gap-2 text-neutral-500 text-sm">
                <Loader2 className="w-4 h-4 animate-spin" />
                Waiting for approval…
              </div>
            )}
          </div>
        </div>
      ) : linked ? (
        <div className="mt-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 text-green-400 text-sm">
              <CheckCircle className="w-4 h-4" />
              Linked
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={startLink} disabled={linking}>
                Link again
              </Button>
              <Button variant="outline" size="sm" onClick={onUnlink} disabled={linking}>
                Unlink
              </Button>
            </div>
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="mt-2 h-7 px-2"
            onClick={() => onShowApiKeyChange(!showApiKey)}
          >
            {showApiKey ? "Hide API key" : "Show API key"}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" className="mt-3" onClick={startLink} disabled={linking}>
          {linking ? (
            <>
              <Loader2 className="w-4 h-4 animate-spin mr-2" />
              Starting…
            </>
          ) : (
            "Link device"
          )}
        </Button>
      )}
    </div>
  );
}
