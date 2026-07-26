import crypto from "crypto";
import fs from "fs";
import path from "path";
import { app } from "electron";
import { store } from "../store.js";
import { LIMBO_API_DEFAULT_PORT, LIMBO_API_VERSION } from "./constants.js";

export type LimboApiDiscovery = {
  version: number;
  port: number;
  token: string;
  host: string;
  baseUrl: string;
  updatedAt: string;
};

function discoveryPath(): string {
  return path.join(app.getPath("userData"), "api.json");
}

export function ensureApiToken(): string {
  const settings = store.get("settings");
  if (settings.apiToken && settings.apiToken.length >= 16) {
    return settings.apiToken;
  }

  const token = crypto.randomBytes(24).toString("hex");
  store.set("settings", { ...settings, apiToken: token });
  return token;
}

export function getApiPort(): number {
  const settings = store.get("settings");
  const port = settings.apiPort ?? LIMBO_API_DEFAULT_PORT;
  return Number.isFinite(port) && port > 0 && port < 65536 ? port : LIMBO_API_DEFAULT_PORT;
}

export function isApiEnabled(): boolean {
  const settings = store.get("settings");
  return settings.apiEnabled !== false;
}

export function writeApiDiscovery(port: number, token: string): LimboApiDiscovery {
  const discovery: LimboApiDiscovery = {
    version: LIMBO_API_VERSION,
    port,
    token,
    host: "127.0.0.1",
    baseUrl: `http://127.0.0.1:${port}`,
    updatedAt: new Date().toISOString(),
  };

  const filePath = discoveryPath();
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(discovery, null, 2)}\n`, "utf8");
  return discovery;
}

export function clearApiDiscovery(): void {
  try {
    fs.unlinkSync(discoveryPath());
  } catch {
    // ignore missing file
  }
}

export function getDiscoveryPath(): string {
  return discoveryPath();
}
