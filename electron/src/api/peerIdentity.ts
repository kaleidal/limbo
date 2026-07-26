import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { app } from "electron";

const execFileAsync = promisify(execFile);

export type VerifiedPeerIdentity = {
  pid: number | null;
  exePath: string | null;
  displayName: string | null;
  iconDataUrl: string | null;
  trustKey: string | null;
  method: "tcp-peer" | "unknown";
};

function normalizeExePath(exePath: string): string {
  try {
    return path.normalize(fs.realpathSync.native?.(exePath) ?? fs.realpathSync(exePath));
  } catch {
    return path.normalize(exePath);
  }
}

function trustKeyForExe(exePath: string): string {
  return `exe:${normalizeExePath(exePath).toLowerCase()}`;
}

function displayNameFromExe(exePath: string): string {
  const base = path.basename(exePath, path.extname(exePath));
  if (!base) return path.basename(exePath) || "Unknown app";
  // Electron apps are often "App Name.exe"
  return base;
}

async function iconForExe(exePath: string): Promise<string | null> {
  try {
    const image = await app.getFileIcon(exePath, { size: "large" });
    if (!image || image.isEmpty()) return null;
    return image.toDataURL();
  } catch {
    return null;
  }
}

async function resolvePidWindows(remotePort: number): Promise<number | null> {
  try {
    // Server sees the client's ephemeral port as remotePort. On this machine that is
    // the client's LocalPort for the loopback connection.
    const script = [
      `$port = ${remotePort};`,
      `$c = Get-NetTCPConnection -LocalPort $port -State Established -ErrorAction SilentlyContinue |`,
      `  Where-Object { $_.RemoteAddress -eq '127.0.0.1' -or $_.LocalAddress -eq '127.0.0.1' } |`,
      `  Select-Object -First 1;`,
      `if (-not $c) {`,
      `  $c = Get-NetTCPConnection -LocalPort $port -ErrorAction SilentlyContinue | Select-Object -First 1`,
      `}`,
      `if ($c) { Write-Output $c.OwningProcess }`,
    ].join(" ");
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 4000 }
    );
    const pid = Number.parseInt(stdout.trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function resolveExeWindows(pid: number): Promise<string | null> {
  try {
    const script = `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if ($p -and $p.Path) { Write-Output $p.Path }`;
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { windowsHide: true, timeout: 4000 }
    );
    const exe = stdout.trim();
    return exe && fs.existsSync(exe) ? exe : null;
  } catch {
    return null;
  }
}

async function resolvePidUnix(remotePort: number): Promise<number | null> {
  try {
    // Match the client side of the loopback socket (local ephemeral port).
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:@127.0.0.1:${remotePort}`, "-sTCP:ESTABLISHED"],
      { timeout: 4000 }
    );
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const command = parts[0] || "";
      const pid = Number.parseInt(parts[1], 10);
      // Skip Limbo itself if it somehow appears.
      if (command.toLowerCase().includes("limbo")) continue;
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        return pid;
      }
    }
  } catch {
    // ignore
  }

  try {
    const { stdout } = await execFileAsync(
      "lsof",
      ["-nP", `-iTCP:${remotePort}`, "-sTCP:ESTABLISHED"],
      { timeout: 4000 }
    );
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    for (const line of lines.slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) continue;
      const pid = Number.parseInt(parts[1], 10);
      if (Number.isFinite(pid) && pid > 0 && pid !== process.pid) {
        return pid;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

async function resolveExeUnix(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const link = fs.readlinkSync(`/proc/${pid}/exe`);
      if (link && fs.existsSync(link)) return link;
    }
  } catch {
    // ignore
  }

  try {
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "comm="], {
      timeout: 3000,
    });
    // macOS: prefer full path via lsof
    const { stdout: lsofOut } = await execFileAsync("lsof", ["-p", String(pid), "-Fn"], {
      timeout: 4000,
    });
    const fileLines = lsofOut
      .split(/\r?\n/)
      .filter((line) => line.startsWith("n/"))
      .map((line) => line.slice(1));
    const preferred =
      fileLines.find((line) => line.endsWith(".app/Contents/MacOS/" + path.basename(line))) ||
      fileLines.find((line) => line.includes(".app/Contents/MacOS/")) ||
      fileLines.find((line) => fs.existsSync(line) && !line.startsWith("/dev/"));
    if (preferred && fs.existsSync(preferred)) return preferred;

    const comm = stdout.trim();
    return comm || null;
  } catch {
    return null;
  }
}

/**
 * Identify the local process that opened this loopback TCP connection.
 * Identity comes from OS process tables — not from request body fields.
 */
export async function resolvePeerIdentity(remotePort: number | undefined): Promise<VerifiedPeerIdentity> {
  const empty: VerifiedPeerIdentity = {
    pid: null,
    exePath: null,
    displayName: null,
    iconDataUrl: null,
    trustKey: null,
    method: "unknown",
  };

  if (!remotePort || !Number.isFinite(remotePort) || remotePort <= 0) {
    return empty;
  }

  let pid: number | null = null;
  let exePath: string | null = null;

  if (process.platform === "win32") {
    pid = await resolvePidWindows(remotePort);
    if (pid) exePath = await resolveExeWindows(pid);
  } else {
    pid = await resolvePidUnix(remotePort);
    if (pid) exePath = await resolveExeUnix(pid);
  }

  if (!exePath) {
    return { ...empty, pid, method: pid ? "tcp-peer" : "unknown" };
  }

  const normalized = normalizeExePath(exePath);
  const iconDataUrl = await iconForExe(normalized);

  return {
    pid,
    exePath: normalized,
    displayName: displayNameFromExe(normalized),
    iconDataUrl,
    trustKey: trustKeyForExe(normalized),
    method: "tcp-peer",
  };
}

export { trustKeyForExe, normalizeExePath };
