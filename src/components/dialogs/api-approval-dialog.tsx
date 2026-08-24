import { useEffect, useState, type ReactNode } from "react";
import { Magnet, ShieldAlert, ShieldCheck } from "lucide-react";
import { useOccludeGuest } from "@/hooks/use-occlude-guest";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import type { ApiApprovalRequest } from "@/types/desktop.d";

type Props = {
  request: ApiApprovalRequest | null;
  onDecide: (approved: boolean, remember: boolean) => void;
};

export function ApiApprovalDialog({ request, onDecide }: Props) {
  const [remember, setRemember] = useState(false);
  const guestOcclusionReady = useOccludeGuest(Boolean(request));

  useEffect(() => {
    setRemember(false);
    if (request) window.sabine?.window.focus();
  }, [request]);

  useEffect(() => {
    if (!request) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDecide(false, false);
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onDecide, request]);

  if (!request) return null;

  const verified = request.verified;
  const claimedName = request.clientName || request.clientId || "An app";
  const processName = verified.displayName || basename(verified.exePath) || "Unknown process";
  const processVerified = Boolean(verified.exePath);
  const claimMismatch =
    processVerified &&
    !processName.toLowerCase().includes(claimedName.toLowerCase()) &&
    !claimedName.toLowerCase().includes(processName.toLowerCase());

  return (
    <AlertDialog open={guestOcclusionReady}>
      <AlertDialogContent
        size="sm"
        className="w-[min(31rem,calc(100vw-2rem))] max-w-none overflow-hidden border border-neutral-700 bg-neutral-900 p-0 text-neutral-100 shadow-[0_24px_80px_rgba(0,0,0,0.58)]"
      >
        <div className="border-b border-neutral-800 bg-neutral-950 px-5 py-4">
          <AlertDialogHeader className="grid-cols-[auto_1fr] place-items-start gap-x-3 text-left">
            <div className="row-span-2 flex size-10 items-center justify-center bg-lime-500/10 text-lime-400">
              <Magnet className="size-5" />
            </div>
            <AlertDialogTitle className="text-base font-semibold text-neutral-50">
              Allow torrent?
            </AlertDialogTitle>
            <AlertDialogDescription className="max-w-none text-sm leading-5 text-neutral-400">
              <span className="text-neutral-200">{processName}</span> wants to add a torrent through Limbo.
            </AlertDialogDescription>
          </AlertDialogHeader>
        </div>

        <div className="space-y-3 px-5 py-1">
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
          <Detail label="Process" mono>
            {verified.exePath || "Unknown executable"}
          </Detail>
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

          <div className="flex items-center justify-between gap-4 border-t border-neutral-800 py-4">
            <div className="min-w-0">
              <p className="text-sm font-medium text-neutral-100">Always allow {processName}</p>
              <p className="mt-1 text-xs text-neutral-500">
                {processVerified
                  ? "Skip this prompt for this executable next time."
                  : "Unavailable because the requesting executable was not verified."}
              </p>
            </div>
            <Switch
              checked={remember}
              disabled={!verified.trustKey}
              onCheckedChange={setRemember}
            />
          </div>
        </div>

        <AlertDialogFooter className="flex-row justify-end border-t border-neutral-800 bg-neutral-950 px-5 py-4">
          <Button variant="outline" className="min-w-24 active:scale-[0.98]" onClick={() => onDecide(false, false)}>
            Deny
          </Button>
          <Button className="min-w-24 bg-lime-500 text-neutral-950 hover:bg-lime-400 active:scale-[0.98]" onClick={() => onDecide(true, remember)}>
            Allow
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
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
