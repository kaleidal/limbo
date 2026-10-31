import { useEffect, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { Download, X, Link, Magnet, Zap, AlertCircle, CheckCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commands } from "@/lib/bindings";
import { errorMessage, isMagnet, isVpnRequired, magnetName } from "@/lib/transfers";
import { useAppStore } from "@/store/app-store";

const EXPIRY_MS = 20_000;
const FILE_HOSTS = /rapidgator|nitroflare|uploadgig|1fichier|mediafire|turbobit|katfile|filefactory/i;

function friendlyError(error: unknown) {
  if (isVpnRequired(error)) {
    return "VPN required for torrents. Connect a VPN or turn off the check in Settings.";
  }
  return errorMessage(error) || "Download failed";
}

function summary(links: string[]) {
  if (links.length === 1) {
    const [link] = links;
    if (isMagnet(link)) return magnetName(link);
    return link.length > 50 ? `${link.slice(0, 50)}…` : link;
  }
  const magnets = links.filter(isMagnet).length;
  const others = links.length - magnets;
  return [
    magnets > 0 ? `${magnets} magnet${magnets > 1 ? "s" : ""}` : null,
    others > 0 ? `${others} link${others > 1 ? "s" : ""}` : null,
  ]
    .filter(Boolean)
    .join(" + ");
}

export function ClipboardMonitor() {
  const { links, expire, dismiss, debridAvailable } = useAppStore(
    useShallow((state) => ({
      links: state.incomingLinks,
      expire: state.incomingLinksExpire,
      dismiss: state.dismissIncomingLinks,
      debridAvailable: !!state.settings?.debrid.service && !!state.settings.debrid.apiKey,
    })),
  );
  const [debridSupported, setDebridSupported] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [startedCount, setStartedCount] = useState(0);

  useEffect(() => {
    setError(null);
    setStartedCount(0);
    if (!expire || links.length === 0) return;
    const timer = window.setTimeout(dismiss, EXPIRY_MS);
    return () => window.clearTimeout(timer);
  }, [dismiss, expire, links]);

  useEffect(() => {
    setDebridSupported(false);
    if (!debridAvailable || links.length === 0) return;
    let cancelled = false;
    const webLinks = links.filter((link) => !isMagnet(link));
    void Promise.all(
      webLinks.map((url) => commands.debridUrlSupported({ url }).catch(() => false)),
    ).then((supported) => {
      if (!cancelled) setDebridSupported(supported.every(Boolean));
    });
    return () => {
      cancelled = true;
    };
  }, [debridAvailable, links]);

  if (links.length === 0) return null;

  const hasMagnets = links.some(isMagnet);
  const offerDebrid = debridAvailable && debridSupported;
  const countSuffix = links.length > 1 ? ` (${links.length})` : "";

  const downloadAll = async (useDebrid: boolean) => {
    setIsProcessing(true);
    setError(null);
    setStartedCount(0);

    let started = 0;
    const errors: string[] = [];
    const warnings: string[] = [];
    for (const link of links) {
      try {
        if (isMagnet(link) && useDebrid) {
          await commands.debridDownloadMagnet({ magnetUri: link });
        } else if (isMagnet(link)) {
          await commands.torrentsAdd({ magnetUri: link });
        } else {
          const { debridError } = await commands.downloadsStart({ url: link, useDebrid });
          if (debridError) warnings.push(`${debridError}. Downloading directly instead.`);
        }
        started++;
        setStartedCount(started);
      } catch (failure) {
        errors.push(friendlyError(failure));
      }
    }
    setIsProcessing(false);

    if (errors.length > 0) {
      const needsDebrid = !debridAvailable && links.some((link) => FILE_HOSTS.test(link));
      setError(
        needsDebrid
          ? "This file host needs a Debrid service. Set one up in Settings."
          : `${errors.length} failed: ${errors[0]}`,
      );
    } else if (warnings.length > 0) {
      setError(warnings[0]);
    }

    if (started > 0) {
      useAppStore.getState().showDownloads(hasMagnets && !useDebrid ? "torrents" : "downloads");
      if (errors.length === 0) window.setTimeout(dismiss, warnings.length > 0 ? 5_000 : 1_500);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-50 animate-in slide-in-from-right-5 fade-in duration-300">
      <div className="bg-neutral-900 border border-neutral-700 rounded-lg shadow-xl p-4 w-80">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-lime-500/20 rounded-lg shrink-0">
            {hasMagnets ? (
              <Magnet className="w-5 h-5 text-lime-500" />
            ) : (
              <Link className="w-5 h-5 text-lime-500" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-neutral-100">
              {links.length === 1
                ? hasMagnets
                  ? "Magnet link"
                  : "Download link"
                : `${links.length} links`}
            </p>
            <p className="text-xs text-neutral-400 truncate mt-1" title={links.join("\n")}>
              {summary(links)}
            </p>
          </div>
          <button
            onClick={dismiss}
            className="p-1 hover:bg-neutral-800 rounded transition-colors shrink-0"
          >
            <X className="w-4 h-4 text-neutral-500" />
          </button>
        </div>

        {error && (
          <div className="flex items-center gap-2 mt-3 p-2 bg-red-950/50 border border-red-900/50 rounded text-red-400 text-xs">
            <AlertCircle className="w-3 h-3 shrink-0" />
            <span className="truncate" title={error}>
              {error}
            </span>
          </div>
        )}

        {startedCount > 0 && isProcessing && (
          <div className="flex items-center gap-2 mt-3 p-2 bg-lime-950/50 border border-lime-900/50 rounded text-lime-400 text-xs">
            <CheckCircle className="w-3 h-3 shrink-0" />
            <span>
              Started {startedCount} of {links.length}
            </span>
          </div>
        )}

        <div className="flex flex-col gap-2 mt-3">
          {offerDebrid && (
            <Button
              onClick={() => downloadAll(true)}
              disabled={isProcessing}
              size="sm"
              className="w-full gap-2"
            >
              <Zap className="w-4 h-4" />
              {isProcessing ? "Starting…" : `Download via Debrid${countSuffix}`}
            </Button>
          )}

          <Button
            onClick={() => downloadAll(false)}
            disabled={isProcessing}
            variant={offerDebrid ? "outline" : "default"}
            size="sm"
            className="w-full gap-2"
          >
            <Download className="w-4 h-4" />
            {isProcessing
              ? "Starting…"
              : hasMagnets
                ? `Download via torrent${countSuffix}`
                : `Download directly${countSuffix}`}
          </Button>

          {!hasMagnets && debridAvailable && !debridSupported && (
            <p className="text-xs text-amber-500 text-center">
              Your Debrid service doesn&apos;t support this host
            </p>
          )}

          <Button onClick={dismiss} variant="ghost" size="sm" className="w-full">
            Dismiss
          </Button>
        </div>
      </div>
    </div>
  );
}
