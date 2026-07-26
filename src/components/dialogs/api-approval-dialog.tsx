import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Magnet, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import {
  approvalRequestIdFromUrl,
  getApprovalBridge,
  type ApiApprovalRequest,
} from "@/lib/api-approval";

function truncate(value: string, max: number) {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function basename(filePath: string) {
  const parts = filePath.split(/[/\\]/);
  return parts[parts.length - 1] || filePath;
}

export function ApiApprovalDialog() {
  const [request, setRequest] = useState<ApiApprovalRequest | null>(null);
  const [remember, setRemember] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const requestId = useMemo(() => approvalRequestIdFromUrl(), []);

  const decide = (approved: boolean) => {
    if (!requestId) return;
    const bridge = getApprovalBridge();
    bridge?.decide({
      requestId,
      approved,
      remember: approved ? remember : false,
    });
  };

  useEffect(() => {
    const bridge = getApprovalBridge();
    if (!requestId || !bridge) {
      setLoadError("This approval prompt could not load.");
      return;
    }

    let cancelled = false;
    bridge
      .getRequest(requestId)
      .then((payload) => {
        if (cancelled) return;
        if (!payload) {
          setLoadError("This approval request expired.");
          return;
        }
        setRequest(payload);
      })
      .catch(() => {
        if (!cancelled) setLoadError("Failed to load approval details.");
      });

    return () => {
      cancelled = true;
    };
  }, [requestId]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") decide(false);
      if (event.key === "Enter") decide(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  if (loadError) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 px-6 text-center text-sm text-neutral-400">
        {loadError}
      </div>
    );
  }

  if (!request) {
    return (
      <div className="flex h-full items-center justify-center bg-neutral-950 text-sm text-neutral-500">
        Loading…
      </div>
    );
  }

  const verified = request.verified;
  const verifiedName = verified?.displayName || null;
  const claimedName = request.clientName || request.clientId || "An app";
  const processLabel = verified?.exePath
    ? basename(verified.exePath)
    : verifiedName || "Unknown process";
  const claimMismatch =
    Boolean(verifiedName) &&
    Boolean(claimedName) &&
    verifiedName!.toLowerCase() !== claimedName.toLowerCase() &&
    !verifiedName!.toLowerCase().includes(claimedName.toLowerCase());
  const torrentTitle = truncate(request.displayName || "Untitled torrent", 72);
  const fileLabel =
    request.fileIndex == null
      ? "Auto-select video file"
      : `File index ${request.fileIndex}`;
  const modeLabel = request.sequential
    ? "Sequential stream download"
    : "Normal download";
  const canRemember = Boolean(verified?.trustKey);
  const rememberLabel = verified?.exePath
    ? `Always allow ${basename(verified.exePath)}`
    : `Always allow ${claimedName}`;

  return (
    <div className="flex h-full flex-col overflow-hidden bg-neutral-900 text-neutral-100">
      <div className="app-drag border-b border-neutral-800 bg-linear-to-r from-neutral-900 via-neutral-950 to-neutral-900 px-5 py-4">
        <div className="app-no-drag flex items-start gap-3">
          {verified?.iconDataUrl ? (
            <img
              src={verified.iconDataUrl}
              alt=""
              className="size-10 shrink-0 object-contain"
            />
          ) : (
            <Magnet className="size-8 shrink-0 text-lime-500" />
          )}
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-neutral-50">
              Allow torrent?
            </h1>
            <p className="mt-1 text-sm leading-6 text-neutral-400">
              <span className="text-neutral-200">{processLabel}</span> wants to
              add a torrent through Limbo.
            </p>
            <p className="mt-2 flex items-center gap-1.5 text-xs">
              {verified?.exePath ? (
                <>
                  <ShieldCheck className="size-3.5 text-lime-500" />
                  <span className="text-lime-500">
                    Verified process
                    {verified.pid ? ` · PID ${verified.pid}` : ""}
                  </span>
                </>
              ) : (
                <>
                  <ShieldAlert className="size-3.5 text-amber-500" />
                  <span className="text-amber-500">
                    Process not verified · treating as untrusted
                  </span>
                </>
              )}
            </p>
          </div>
        </div>
      </div>

      <div className="app-no-drag flex-1 space-y-3 overflow-auto px-5 py-4">
        <DetailRow label="Process">
          <span className="break-all font-mono text-[11px] leading-4 text-neutral-300">
            {verified?.exePath
              ? truncate(verified.exePath, 120)
              : "Could not verify calling process"}
          </span>
        </DetailRow>

        {claimMismatch ? (
          <DetailRow label="Claims">
            <span className="text-amber-400">
              {claimedName}
              {request.clientVersion ? ` ${request.clientVersion}` : ""}{" "}
              (self-reported, not trusted)
            </span>
          </DetailRow>
        ) : null}

        <DetailRow label="Torrent">{torrentTitle}</DetailRow>
        <DetailRow label="Selection">{fileLabel}</DetailRow>
        <DetailRow label="Mode">{modeLabel}</DetailRow>
        <DetailRow label="Magnet">
          <span className="break-all font-mono text-[11px] leading-4 text-neutral-400">
            {truncate(request.magnet, 96)}
          </span>
        </DetailRow>

        <div className="flex items-center justify-between gap-4 border border-neutral-800 bg-neutral-950 px-3 py-3">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-100">
              {rememberLabel}
            </p>
            <p className="mt-0.5 text-xs text-neutral-500">
              Skip this prompt for this verified app next time.
            </p>
          </div>
          <Switch
            checked={remember}
            disabled={!canRemember}
            onCheckedChange={setRemember}
          />
        </div>
      </div>

      <div className="app-no-drag flex justify-end gap-2 border-t border-neutral-800 bg-neutral-950 px-5 py-4">
        <Button
          variant="outline"
          size="default"
          className="min-w-24 px-5"
          onClick={() => decide(false)}
        >
          Deny
        </Button>
        <Button
          size="default"
          className="min-w-24 bg-lime-500 px-5 text-neutral-900 hover:bg-lime-400"
          onClick={() => decide(true)}
        >
          Allow
        </Button>
      </div>
    </div>
  );
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="grid grid-cols-[5.5rem_1fr] gap-3 text-sm">
      <div className="pt-0.5 text-xs text-neutral-500">{label}</div>
      <div className="min-w-0 text-neutral-200">{children}</div>
    </div>
  );
}
