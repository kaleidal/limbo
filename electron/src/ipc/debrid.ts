// Debrid IPC handlers

import { ipcMain, BrowserWindow } from "electron";
import { store } from "../store.js";
import { convertMagnetWithDebrid, getSupportedHosts } from "../debrid.js";

type RealDebridDeviceState = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  interval: number;
  expiresAt: number;
};

const RD_PUBLIC_CLIENT_ID = "X245A4XAIBGVM";
let rdDeviceState: RealDebridDeviceState | null = null;

export function registerDebridHandlers(getMainWindow: () => BrowserWindow | null) {
  ipcMain.handle("is-debrid-configured", () => {
    const settings = store.get("settings");
    return settings.debrid.service !== null && settings.debrid.apiKey !== "";
  });

  ipcMain.handle("convert-magnet-debrid", async (_, magnetUri: string) => {
    const settings = store.get("settings");
    if (!settings.debrid.service || !settings.debrid.apiKey) {
      throw new Error("Debrid service not configured");
    }
    const links = await convertMagnetWithDebrid(magnetUri, settings.debrid);
    if (!links || links.length === 0) {
      throw new Error("Failed to convert magnet link");
    }
    for (const link of links) {
      getMainWindow()?.webContents.downloadURL(link);
    }
    return links;
  });

  // Get supported hosts from the configured debrid service
  ipcMain.handle("get-supported-hosts", async () => {
    const settings = store.get("settings");
    if (!settings.debrid.service || !settings.debrid.apiKey) {
      return { hosts: [], error: "No debrid service configured" };
    }
    return getSupportedHosts(settings.debrid);
  });

  // Real-Debrid device linking (OAuth device flow)
  ipcMain.handle("realdebrid-device-start", async () => {
    const response = await fetch(
      `https://api.real-debrid.com/oauth/v2/device/code?client_id=${encodeURIComponent(
        RD_PUBLIC_CLIENT_ID
      )}&new_credentials=yes`
    );

    if (!response.ok) {
      const err = await response.text().catch(() => "");
      return { success: false, error: `Real-Debrid: ${response.status} ${response.statusText} ${err}` };
    }

    const data: any = await response.json();
    if (!data?.device_code || !data?.user_code || !data?.verification_url) {
      return { success: false, error: "Real-Debrid: Unexpected device code response" };
    }

    const interval = typeof data.interval === "number" ? data.interval : 5;
    const expiresIn = typeof data.expires_in === "number" ? data.expires_in : 600;
    rdDeviceState = {
      deviceCode: data.device_code,
      userCode: data.user_code,
      verificationUrl: data.verification_url,
      interval,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return {
      success: true,
      userCode: rdDeviceState.userCode,
      verificationUrl: rdDeviceState.verificationUrl,
      interval: rdDeviceState.interval,
      expiresIn,
    };
  });

  ipcMain.handle("realdebrid-device-cancel", async () => {
    rdDeviceState = null;
    return { success: true };
  });

  ipcMain.handle("realdebrid-device-poll", async () => {
    if (!rdDeviceState) {
      return { status: "idle" as const };
    }

    if (Date.now() >= rdDeviceState.expiresAt) {
      rdDeviceState = null;
      return { status: "expired" as const, error: "Real-Debrid: Device code expired" };
    }

    // Step 1: retrieve per-user client credentials (available after user confirms)
    const credsResp = await fetch(
      `https://api.real-debrid.com/oauth/v2/device/credentials?client_id=${encodeURIComponent(
        RD_PUBLIC_CLIENT_ID
      )}&code=${encodeURIComponent(rdDeviceState.deviceCode)}`
    );

    if (!credsResp.ok) {
      // Common case while pending: not authorized yet
      return { status: "pending" as const };
    }

    const creds: any = await credsResp.json().catch(() => null);
    if (!creds?.client_id || !creds?.client_secret) {
      return { status: "pending" as const };
    }

    // Step 2: exchange device code for access token
    const form = new URLSearchParams();
    form.set("client_id", creds.client_id);
    form.set("client_secret", creds.client_secret);
    form.set("code", rdDeviceState.deviceCode);
    form.set("grant_type", "http://oauth.net/grant_type/device/1.0");

    const tokenResp = await fetch("https://api.real-debrid.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (!tokenResp.ok) {
      const errText = await tokenResp.text().catch(() => "");
      return {
        status: "error" as const,
        error: `Real-Debrid: Token request failed (${tokenResp.status}) ${errText}`,
      };
    }

    const token: any = await tokenResp.json().catch(() => null);
    if (!token?.access_token) {
      return { status: "error" as const, error: "Real-Debrid: No access_token returned" };
    }

    const settings = store.get("settings");
    store.set("settings", {
      ...settings,
      debrid: {
        ...settings.debrid,
        service: "realdebrid",
        apiKey: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: Date.now() + (token.expires_in * 1000),
        clientId: creds.client_id,
        clientSecret: creds.client_secret,
      },
    });

    rdDeviceState = null;
    return { status: "success" as const, accessToken: token.access_token };
  });
}
