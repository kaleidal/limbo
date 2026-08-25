import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Magnet, ShieldAlert, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ApiApprovalRequest } from "@/types/desktop.d";

export function ApiApprovalWindow() {
  const [request, setRequest] = useState<ApiApprovalRequest | null>(null);
  const [remember, setRemember] = useState(false);

  const showRequest = useCallback((next: ApiApprovalRequest) => {
    setRequest(next);
    setRemember(false);
    window.sabine?.window.show();
    window.sabine?.window.focus();
  }, []);

  const close = useCallback(() => {
    setRequest(null);
    setRemember(false);
    window.sabine?.window.close();
  }, []);

  const decide = useCallback(async (approved: boolean, rememberDecision: boolean) => {
    if (!request || !window.limbo) return;
    const requestId = request.requestId;
    await window.limbo.decideApiApproval(requestId, approved, rememberDecision).catch(() => undefined);
    close();
  }, [close, request]);

  useEffect(() => {
    let active = true;
    void window.limbo?.getPendingApiApproval().then((pending) => {
      if (active && pending) showRequest(pending);
    });
    const stopRequested = window.sabine?.bridge.listen("api-approval-requested", (payload) => {
      if (active) showRequest(payload as unknown as ApiApprovalRequest);
    });
    const stopExpired = window.sabine?.bridge.listen("api-approval-expired", (payload) => {
      const expired = payload as { requestId?: string };
      setRequest((current) => {
        if (current?.requestId !== expired.requestId) return current;
        window.sabine?.window.close();
        return null;
      });
    });
    return () => {
      active = false;
      stopRequested?.();
      stopExpired?.();
    };
  }, [showRequest]);

  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") void decide(false, false);
      if (event.key === "Enter") void decide(true, remember);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [decide, remember, request]);

  if (!request) {
    return <main className="h-screen bg-neutral-950" />;
  }

  const verified = request.verified;
  const claimedName = request.clientName || request.clientId || "An app";
  const processName = verified.displayName || basename(verified.exePath) || "Unknown process";
  const processVerified = Boolean(verified.exePath);
  const claimMismatch =
    processVerified &&
    !processName.toLowerCase().includes(claimedName.toLowerCase()) &&
    !claimedName.toLowerCase().includes(processName.toLowerCase());

  return (
    <main className="flex h-screen flex-col overflow-hidden border border-neutral-700 bg-neutral-900 text-neutral-100 shadow-[0_24px_80px_rgba(0,0,0,0.7)]">
      <header className="border-b border-neutral-800 bg-neutral-950 px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center bg-lime-500/10 text-lime-400">
            <Magnet className="size-5" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="text-base font-semibold text-neutral-50">Allow torrent?</h1>
            <p className="mt-1 text-sm leading-5 text-neutral-400">
              <span className="text-neutral-200">{processName}</span> wants to add a torrent through Limbo.
            </p>
          </div>
        </div>
      </header>

      <section className="min-h-0 flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <div className="flex items-center gap-2 text-xs">
          {processVerified ? (
            <>
              <ShieldCheck className="size-4 text-lime-400" />
              <span className="text-lime-400">
                Verified process{verified.pid ? ` · PID ${verified.pid}` : ""}
              </span>
            </>
          ) : (
            <>
              <ShieldAlert className="size-4 text-amber-400" />
              <span className="text-amber-400">Process could not be verified</span>
            </>
          )}
        </div>
        <Detail label="Process" mono>{verified.exePath || "Unknown executable"}</Detail>
        {claimMismatch ? (
          <Detail label="Claims">
            <span className="text-amber-300">
              {claimedName}{request.clientVersion ? ` ${request.clientVersion}` : ""} (self-reported)
            </span>
          </Detail>
        ) : null}
        <Detail label="Torrent">{truncate(request.displayName, 78)}</Detail>
        <Detail label="Selection">
          {request.fileIndex == null ? "Largest video file" : `File index ${request.fileIndex}`}
        </Detail>
        <Detail label="Mode">
          {request.sequential ? "Sequential stream download" : "Normal download"}
        </Detail>
        <Detail label="Magnet" mono>{truncate(request.magnet, 112)}</Detail>

        <div className="flex items-center justify-between gap-4 border-t border-neutral-800 pt-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-neutral-100">Always allow {processName}</p>
            <p className="mt-1 text-xs text-neutral-500">
              {processVerified
                ? "Skip this prompt for this executable next time."
                : "Unavailable because the requesting executable was not verified."}
            </p>
          </div>
          <Switch checked={remember} disabled={!verified.trustKey} onCheckedChange={setRemember} />
        </div>
      </section>

      <footer className="flex justify-end gap-2 border-t border-neutral-800 bg-neutral-950 px-5 py-4">
        <Button variant="outline" className="min-w-24 active:scale-[0.98]" onClick={() => void decide(false, false)}>
          Deny
        </Button>
        <Button className="min-w-24 bg-lime-500 text-neutral-950 hover:bg-lime-400 active:scale-[0.98]" onClick={() => void decide(true, remember)}>
          Allow
        </Button>
      </footer>
    </main>
  );
}

function Detail({ label, children, mono = false }: { label: string; children: ReactNode; mono?: boolean }) {
  return (
    <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] gap-3 text-sm">
      <span className="text-xs text-neutral-500">{label}</span>
      <span className={mono ? "break-all font-mono text-[11px] leading-4 text-neutral-300" : "min-w-0 text-neutral-200"}>
        {children}
      </span>
    </div>
  );
}

function basename(path: string | null) {
  if (!path) return null;
  return path.split(/[/\\]/).at(-1)?.replace(/\.[^.]+$/, "") || null;
}

function truncate(value: string, length: number) {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}
