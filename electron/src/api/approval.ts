import { BrowserWindow, ipcMain, screen, app } from "electron";
import fs from "fs";
import path from "path";
import { pathToFileURL, fileURLToPath } from "url";
import { store } from "../store.js";
import {
  resolvePeerIdentity,
  type VerifiedPeerIdentity,
} from "./peerIdentity.js";

export type ApiClientIdentity = {
  clientId: string;
  clientName: string;
  clientVersion?: string;
  /** Ignored for display when peer identity is verified — kept only as a claim. */
  clientIconDataUrl?: string;
};

export type TorrentApprovalRequest = ApiClientIdentity & {
  magnet: string;
  displayName: string;
  fileIndex: number | null;
  sequential: boolean;
  remotePort?: number;
  verified?: VerifiedPeerIdentity;
};

export type TorrentApprovalDecision =
  | { approved: true; remember: boolean }
  | { approved: false; reason: "denied" | "timeout" | "closed" };

const APPROVAL_TIMEOUT_MS = 90_000;
const DECISION_CHANNEL = "limbo-api-approval-decision";
const GET_CHANNEL = "limbo-api-approval-get";

let approvalQueue: Promise<unknown> = Promise.resolve();
let activeWindow: BrowserWindow | null = null;
const pendingById = new Map<string, TorrentApprovalRequest>();
let getHandlerRegistered = false;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function ensureGetHandler() {
  if (getHandlerRegistered) return;
  getHandlerRegistered = true;
  ipcMain.handle(GET_CHANNEL, (_event, requestId: unknown) => {
    if (typeof requestId !== "string") return null;
    return pendingById.get(requestId) ?? null;
  });
}

function resolveLimboIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "../../public/icon.png"),
    path.join(app.getAppPath(), "public/icon.png"),
    path.join(process.resourcesPath || "", "public/icon.png"),
  ];
  for (const candidate of candidates) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate;
    } catch {
      // ignore
    }
  }
  return undefined;
}

function approvalPageUrl(requestId: string): string {
  const query = `?id=${encodeURIComponent(requestId)}`;
  if (process.env.NODE_ENV === "development") {
    return `http://localhost:5177/approval.html${query}`;
  }
  const filePath = path.join(__dirname, "../../dist/approval.html");
  return `${pathToFileURL(filePath).href}${query}`;
}

export function isTrustKeyTrusted(trustKeyValue: string | null | undefined): boolean {
  if (!trustKeyValue) return false;
  const settings = store.get("settings");
  const trusted = settings.trustedApiClients || [];
  return trusted.includes(trustKeyValue);
}

export function trustKey(trustKeyValue: string): void {
  if (!trustKeyValue) return;
  const settings = store.get("settings");
  const trusted = new Set(settings.trustedApiClients || []);
  trusted.add(trustKeyValue);
  store.set("settings", {
    ...settings,
    trustedApiClients: [...trusted],
  });
}

export function untrustClient(trustKeyValue: string): void {
  const settings = store.get("settings");
  const trusted = (settings.trustedApiClients || []).filter((id) => id !== trustKeyValue);
  store.set("settings", {
    ...settings,
    trustedApiClients: trusted,
  });
}

function shouldPrompt(request: TorrentApprovalRequest): boolean {
  const settings = store.get("settings");
  if (settings.apiPromptPolicy === "off") {
    return false;
  }
  // Only skip when the verified executable is trusted. Self-reported clientId alone
  // is not enough — otherwise any process could claim to be a trusted app.
  if (request.verified?.trustKey && isTrustKeyTrusted(request.verified.trustKey)) {
    return false;
  }
  return true;
}

function showApprovalWindow(request: TorrentApprovalRequest): Promise<TorrentApprovalDecision> {
  ensureGetHandler();

  return new Promise((resolve) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    let settled = false;
    pendingById.set(requestId, request);

    const finish = (decision: TorrentApprovalDecision) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      pendingById.delete(requestId);
      ipcMain.removeListener(DECISION_CHANNEL, onDecision);
      if (activeWindow && !activeWindow.isDestroyed()) {
        activeWindow.close();
      }
      activeWindow = null;
      resolve(decision);
    };

    const onDecision = (
      _event: Electron.IpcMainEvent,
      payload: { requestId?: string; approved?: boolean; remember?: boolean }
    ) => {
      if (!payload || payload.requestId !== requestId) return;
      if (payload.approved) {
        finish({ approved: true, remember: Boolean(payload.remember) });
        return;
      }
      finish({ approved: false, reason: "denied" });
    };

    ipcMain.on(DECISION_CHANNEL, onDecision);

    const display = screen.getPrimaryDisplay();
    const width = 480;
    const height = 520;
    const x = Math.round(display.workArea.x + (display.workArea.width - width) / 2);
    const y = Math.round(display.workArea.y + Math.max(48, display.workArea.height * 0.16));

    const win = new BrowserWindow({
      width,
      height,
      x,
      y,
      resizable: false,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      frame: false,
      transparent: false,
      alwaysOnTop: true,
      skipTaskbar: false,
      show: false,
      backgroundColor: "#0a0a0a",
      title: "Limbo",
      icon: resolveLimboIconPath(),
      webPreferences: {
        nodeIntegration: true,
        contextIsolation: false,
        sandbox: false,
      },
    });

    activeWindow = win;
    win.setAlwaysOnTop(true, "screen-saver");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    const timeout = setTimeout(() => {
      finish({ approved: false, reason: "timeout" });
    }, APPROVAL_TIMEOUT_MS);

    win.on("closed", () => {
      if (!settled) {
        finish({ approved: false, reason: "closed" });
      }
    });

    win.webContents.once("did-finish-load", () => {
      if (win.isDestroyed()) return;
      win.show();
      win.focus();
      win.moveTop();
      if (process.platform === "darwin" && app.dock) {
        app.dock.bounce("critical");
      } else if (process.platform === "win32") {
        win.flashFrame(true);
      }
    });

    void win.loadURL(approvalPageUrl(requestId));
  });
}

export async function requestTorrentApproval(
  request: TorrentApprovalRequest
): Promise<TorrentApprovalDecision> {
  const verified = request.verified || (await resolvePeerIdentity(request.remotePort));
  const enriched: TorrentApprovalRequest = {
    ...request,
    verified,
  };

  if (!shouldPrompt(enriched)) {
    return { approved: true, remember: false };
  }

  const run = async () => {
    while (activeWindow && !activeWindow.isDestroyed()) {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return showApprovalWindow(enriched);
  };

  const decisionPromise = approvalQueue.then(run, run);
  approvalQueue = decisionPromise.then(
    () => undefined,
    () => undefined
  );
  const decision = await decisionPromise;

  if (decision.approved && decision.remember && verified.trustKey) {
    trustKey(verified.trustKey);
  }

  return decision;
}
