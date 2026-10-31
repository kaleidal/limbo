import { AlertCircle, Archive, ArrowUp, CheckCircle, Clock, Download, Pause } from "lucide-react";
import type { DownloadStatus, TorrentStatus } from "@/lib/bindings";

export function StatusIcon({ status }: { status: DownloadStatus | TorrentStatus }) {
  switch (status) {
    case "downloading":
      return <Download className="w-4 h-4 text-lime-500 animate-pulse" />;
    case "extracting":
      return <Archive className="w-4 h-4 text-purple-500 animate-pulse" />;
    case "paused":
      return <Pause className="w-4 h-4 text-yellow-500" />;
    case "completed":
      return <CheckCircle className="w-4 h-4 text-blue-500" />;
    case "error":
      return <AlertCircle className="w-4 h-4 text-red-500" />;
    case "pending":
      return <Clock className="w-4 h-4 text-neutral-500" />;
    case "seeding":
      return <ArrowUp className="w-4 h-4 text-blue-500" />;
  }
}
