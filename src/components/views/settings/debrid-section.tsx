import { useCallback, useEffect, useState } from "react";
import { AlertCircle, CheckCircle, Key, Loader2, RefreshCw, Server } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ConfirmDialog } from "@/components/dialogs/confirm-dialog";
import { commands, type DebridProvider, type Settings } from "@/lib/bindings";
import { errorMessage } from "@/lib/transfers";
import { useAppStore } from "@/store/app-store";
import { RealDebridLink } from "./realdebrid-link";
import { Section } from "./section";

const PROVIDERS: { id: DebridProvider; name: string; keyHint: string }[] = [
  { id: "realdebrid", name: "Real-Debrid", keyHint: "real-debrid.com/apitoken" },
  { id: "alldebrid", name: "AllDebrid", keyHint: "alldebrid.com/apikeys" },
  { id: "premiumize", name: "Premiumize", keyHint: "premiumize.me/account" },
  { id: "torbox", name: "TorBox", keyHint: "torbox.app/settings" },
];
const VISIBLE_HOSTS = 50;

function SupportedHosts() {
  const saved = useAppStore((state) => state.settings?.debrid);
  const [hosts, setHosts] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const configured = !!saved?.service && !!saved.apiKey;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setHosts(await commands.debridHosts());
    } catch (failure) {
      setHosts([]);
      setError(errorMessage(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (configured) void refresh();
  }, [configured, refresh, saved?.service, saved?.apiKey]);

  if (!configured) return null;

  return (
    <div className="pt-2 border-t border-neutral-700">
      <div className="flex items-center justify-between mb-2">
        <Label>Supported file hosts</Label>
        <Button variant="ghost" size="sm" onClick={refresh} disabled={loading} className="h-7 px-2">
          {loading ? <Loader2 className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
        </Button>
      </div>
      {error ? (
        <div className="flex items-center gap-2 text-red-400 text-sm">
          <AlertCircle className="w-4 h-4" />
          {error}
        </div>
      ) : loading ? (
        <div className="flex items-center gap-2 text-neutral-500 text-sm">
          <Loader2 className="w-4 h-4 animate-spin" />
          Loading supported hosts…
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-green-400 text-sm">
            <CheckCircle className="w-4 h-4" />
            {hosts.length} hosts supported
          </div>
          <div className="max-h-32 overflow-y-auto bg-neutral-800 rounded p-2">
            <div className="flex flex-wrap gap-1">
              {hosts.slice(0, VISIBLE_HOSTS).map((host) => (
                <span key={host} className="px-2 py-0.5 text-xs bg-neutral-700 rounded text-neutral-300">
                  {host}
                </span>
              ))}
              {hosts.length > VISIBLE_HOSTS && (
                <span className="px-2 py-0.5 text-xs text-neutral-500">
                  +{hosts.length - VISIBLE_HOSTS} more
                </span>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export function DebridSection({
  settings,
  update,
}: {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}) {
  const [showApiKey, setShowApiKey] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState(false);
  const { debrid } = settings;
  const provider = PROVIDERS.find((candidate) => candidate.id === debrid.service);
  const isRealDebrid = debrid.service === "realdebrid";
  const realDebridLinked = isRealDebrid && !!debrid.apiKey;

  const choose = (service: DebridProvider | null) => {
    setShowApiKey(false);
    update({ debrid: { ...debrid, service } });
  };

  const unlink = async () => {
    setConfirmUnlink(false);
    const saved = useAppStore.getState().settings;
    if (!saved) return;
    const updated = await commands.settingsUpdate({
      ...saved,
      debrid: { service: "realdebrid", apiKey: "" },
    });
    useAppStore.getState().setSettings(updated);
    setShowApiKey(true);
  };

  return (
    <Section icon={<Server className="w-5 h-5" />} title="Debrid service">
      <div>
        <Label>Provider</Label>
        <div className="flex flex-wrap gap-2 mt-1">
          {PROVIDERS.map(({ id, name }) => (
            <Button
              key={id}
              variant={debrid.service === id ? "default" : "outline"}
              size="sm"
              onClick={() => choose(id)}
            >
              {name}
            </Button>
          ))}
          <Button
            variant={debrid.service === null ? "default" : "outline"}
            size="sm"
            onClick={() => choose(null)}
          >
            None
          </Button>
        </div>
      </div>

      {provider && (!realDebridLinked || showApiKey) && (
        <div>
          <Label htmlFor="apiKey">API key</Label>
          <div className="relative mt-1">
            <Key className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-500" />
            <Input
              id="apiKey"
              type="password"
              value={debrid.apiKey}
              onChange={(event) => update({ debrid: { ...debrid, apiKey: event.target.value } })}
              placeholder="Enter your API key..."
              className="pl-10 bg-neutral-800 border-neutral-700"
            />
          </div>
          <p className="text-xs text-neutral-500 mt-1">Find your API key at {provider.keyHint}</p>
        </div>
      )}

      {isRealDebrid && (
        <RealDebridLink
          linked={realDebridLinked}
          showApiKey={showApiKey}
          onShowApiKeyChange={setShowApiKey}
          onUnlink={() => setConfirmUnlink(true)}
        />
      )}

      <SupportedHosts />

      <ConfirmDialog
        open={confirmUnlink}
        title="Unlink Real-Debrid?"
        description="Limbo will forget the stored Real-Debrid token."
        confirmLabel="Unlink"
        onConfirm={unlink}
        onCancel={() => setConfirmUnlink(false)}
      />
    </Section>
  );
}
