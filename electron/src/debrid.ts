// Debrid service integration (Real-Debrid, AllDebrid, Premiumize)

import type { DebridConfig, DebridResult } from "./types.js";
import { store } from "./store.js";

type DebridLinkEntry = {
  link?: string;
};

type RemoteTorrentFile = {
  buffer: Buffer;
  filename: string;
};

type PremiumizeTransfer = {
  id?: string;
  folder_id?: string;
};

type PremiumizeFolderItem = {
  link?: string;
};

type AllDebridHostEntry = {
  domain?: string;
  name?: string;
  domains?: string[];
};

type RealDebridTokenResponse = {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
};

type RealDebridErrorResponse = {
  error?: string;
  error_code?: number;
  download?: string;
};

type RealDebridTorrentAddResponse = {
  id?: string;
  uri?: string;
  error?: string;
  error_code?: number;
};

type RealDebridTorrentInfoResponse = {
  links?: string[];
  error?: string;
  error_code?: number;
};

type AllDebridErrorPayload = {
  message?: string;
  code?: string;
};

type AllDebridUploadFileResponse = {
  status?: string;
  error?: AllDebridErrorPayload | string;
  data?: {
    files?: Array<{
      file?: string;
      id?: number;
      ready?: boolean;
      error?: AllDebridErrorPayload;
    }>;
  };
};

type AllDebridMagnetStatusResponse = {
  status?: string;
  error?: AllDebridErrorPayload | string;
  data?: {
    magnets?: Array<{
      id?: number;
      ready?: boolean;
      links?: DebridLinkEntry[];
    }>;
  };
};

type AllDebridMagnetFilesResponse = {
  status?: string;
  error?: AllDebridErrorPayload | string;
  data?: {
    magnets?: Array<{
      id?: number;
      files?: Array<{
        link?: string;
        files?: Array<{
          link?: string;
        }>;
      }>;
    }>;
  };
};

let realDebridRefreshPromise: Promise<DebridConfig> | null = null;

function persistDebridConfig(config: DebridConfig) {
  const settings = store.get("settings");
  store.set("settings", {
    ...settings,
    debrid: config,
  });
}

function getFriendlyDebridError(error: unknown) {
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    if ("message" in error && typeof error.message === "string") return error.message;
    if ("code" in error && typeof error.code === "string") return error.code;
  }
  return "Unknown error";
}

function getRemoteTorrentFilename(url: string) {
  try {
    const parsed = new URL(url);
    const filename = decodeURIComponent(parsed.pathname.split("/").filter(Boolean).pop() || "remote.torrent");
    return filename.toLowerCase().endsWith(".torrent") ? filename : `${filename}.torrent`;
  } catch {
    return "remote.torrent";
  }
}

async function fetchRemoteTorrentFile(url: string): Promise<RemoteTorrentFile> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch torrent file (${response.status})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length === 0) {
    throw new Error("Fetched torrent file was empty");
  }

  return {
    buffer,
    filename: getRemoteTorrentFilename(url),
  };
}

function flattenAllDebridLinks(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  if ("link" in value && typeof value.link === "string") {
    return [value.link];
  }

  if ("files" in value && Array.isArray(value.files)) {
    return value.files.flatMap((entry) => flattenAllDebridLinks(entry));
  }

  return [];
}

function supportsTorrentDebrid(service: DebridConfig["service"]) {
  return service === "realdebrid" || service === "alldebrid";
}

// Check and refresh token if needed
async function refreshRealDebridToken(debrid: DebridConfig): Promise<DebridConfig> {
  if (!debrid.refreshToken || !debrid.clientId || !debrid.clientSecret) {
    return debrid;
  }

  if (!realDebridRefreshPromise) {
    realDebridRefreshPromise = (async () => {
      console.log("[Debrid] Refreshing Real-Debrid access token...");

      const form = new URLSearchParams();
      form.set("client_id", debrid.clientId || "");
      form.set("client_secret", debrid.clientSecret || "");
      form.set("refresh_token", debrid.refreshToken || "");
      form.set("grant_type", "http://oauth.net/grant_type/device/1.0");

      const response = await fetch("https://api.real-debrid.com/oauth/v2/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });

      if (!response.ok) {
        throw new Error(`Token refresh failed: ${response.status} ${response.statusText}`);
      }

      const data = (await response.json()) as RealDebridTokenResponse;
      if (!data.access_token || !data.refresh_token) {
        throw new Error("Token refresh response was missing required fields");
      }

      const refreshedConfig: DebridConfig = {
        ...debrid,
        apiKey: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + ((data.expires_in || 0) * 1000),
      };

      persistDebridConfig(refreshedConfig);
      return refreshedConfig;
    })().finally(() => {
      realDebridRefreshPromise = null;
    });
  }

  try {
    return await realDebridRefreshPromise;
  } catch (error) {
    console.error("[Debrid] Token refresh error:", error);
    return debrid;
  }
}

async function ensureValidToken(debrid: DebridConfig, forceRefresh = false): Promise<DebridConfig> {
  if (debrid.service !== "realdebrid") return debrid;

  if (!debrid.expiresAt || !debrid.refreshToken || !debrid.clientId || !debrid.clientSecret) {
    return debrid;
  }

  if (!forceRefresh && Date.now() < debrid.expiresAt - 5 * 60 * 1000) {
    return debrid;
  }

  return refreshRealDebridToken(debrid);
}

// Unrestrict a link using debrid service
export async function unrestrictLink(url: string, debridConfig: DebridConfig): Promise<DebridResult> {
  let debrid = await ensureValidToken(debridConfig);

  try {
    console.log(`[Debrid] Attempting to unrestrict link via ${debrid.service}: ${url}`);

    if (debrid.service === "realdebrid") {
      const attemptUnrestrict = async () => {
        const response = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${debrid.apiKey}`,
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: `link=${encodeURIComponent(url)}`,
        });
        return (await response.json()) as RealDebridErrorResponse;
      };

      let data = await attemptUnrestrict();
      if ((data.error === "bad_token" || data.error === "bad_token_check") && debrid.refreshToken) {
        debrid = await ensureValidToken(debrid, true);
        data = await attemptUnrestrict();
      }

      if (data.error) {
        console.error(`[Debrid] Real-Debrid error: ${data.error} (code: ${data.error_code})`);
        let friendlyError = data.error;
        if (data.error.startsWith("ip_not_allowed")) {
          friendlyError = "Real-Debrid: IP not allowed. Regenerate API key from current IP or disable VPN.";
        } else if (data.error === "hoster_unavailable" || data.error === "link_host_not_supported") {
          friendlyError = "Real-Debrid: This file host is not supported.";
        } else if (data.error === "bad_token" || data.error === "bad_token_check") {
          friendlyError = "Real-Debrid: Auth token invalid or expired. Please re-link account.";
        }
        return { url: null, error: friendlyError };
      }

      if (data.download) {
        console.log(`[Debrid] Successfully unrestricted link via Real-Debrid`);
        return { url: data.download };
      }

      console.warn(`[Debrid] Real-Debrid returned no download link. Response:`, data);
      return { url: null, error: "Real-Debrid: No download link returned." };
    } else if (debrid.service === "alldebrid") {
      const response = await fetch(
        `https://api.alldebrid.com/v4/link/unlock?agent=limbo&apikey=${debrid.apiKey}&link=${encodeURIComponent(url)}`
      );
      const data = await response.json();

      if (data.status === "error" || data.error) {
        const errMsg = data.error?.message || data.error || "Unknown error";
        console.error(`[Debrid] AllDebrid error: ${errMsg}`);
        return { url: null, error: `AllDebrid: ${errMsg}` };
      }

      if (data.data?.link) {
        console.log(`[Debrid] Successfully unrestricted link via AllDebrid`);
        return { url: data.data.link };
      }

      console.warn(`[Debrid] AllDebrid returned no download link. Response:`, data);
      return { url: null, error: "AllDebrid: No download link returned." };
    } else if (debrid.service === "premiumize") {
      const response = await fetch(`https://www.premiumize.me/api/transfer/directdl?apikey=${debrid.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `src=${encodeURIComponent(url)}`,
      });
      const data = await response.json();

      if (data.status !== "success") {
        console.error(`[Debrid] Premiumize error: ${data.message || "Unknown error"}`);
        return { url: null, error: `Premiumize: ${data.message || "Unknown error"}` };
      }

      if (data.content?.[0]?.link) {
        console.log(`[Debrid] Successfully unrestricted link via Premiumize`);
        return { url: data.content[0].link };
      }

      console.warn(`[Debrid] Premiumize returned no download link. Response:`, data);
      return { url: null, error: "Premiumize: No download link returned." };
    }

    console.warn(`[Debrid] Unknown debrid service: ${debrid.service}`);
    return { url: null, error: `Unknown debrid service: ${debrid.service}` };
  } catch (err) {
    console.error("[Debrid] Error unrestricting link:", err);
    return { url: null, error: `Debrid error: ${err}` };
  }
}

// Convert magnet link using debrid service
export async function convertMagnetWithDebrid(
  magnetUri: string,
  debridConfig: DebridConfig
): Promise<string[] | null> {
  const debrid = await ensureValidToken(debridConfig);

  try {
    if (debrid.service === "realdebrid") {
      // Add the magnet to Real-Debrid
      const addResponse = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addMagnet", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `magnet=${encodeURIComponent(magnetUri)}`,
      });
      const addData = await addResponse.json();

      if (!addData.id) return null;

      // Select all files
      await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "files=all",
      });

      // Wait a moment for processing
      await new Promise((resolve) => setTimeout(resolve, 2000));

      // Get torrent info
      const infoResponse = await fetch(
        `https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`,
        { headers: { Authorization: `Bearer ${debrid.apiKey}` } }
      );
      const infoData = await infoResponse.json();

      // Return the links
      if (infoData.links && infoData.links.length > 0) {
        const unrestrictedLinks: string[] = [];
        for (const link of infoData.links) {
          const result = await unrestrictLink(link, debrid);
          if (result.url) unrestrictedLinks.push(result.url);
        }
        return unrestrictedLinks.length > 0 ? unrestrictedLinks : null;
      }
      return null;
    } else if (debrid.service === "alldebrid") {
      const response = await fetch(
        `https://api.alldebrid.com/v4/magnet/upload?agent=limbo&apikey=${debrid.apiKey}&magnets[]=${encodeURIComponent(magnetUri)}`
      );
      const data = await response.json();

      if (data.data?.magnets?.[0]?.id) {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const statusResponse = await fetch(
          `https://api.alldebrid.com/v4/magnet/status?agent=limbo&apikey=${debrid.apiKey}&id=${data.data.magnets[0].id}`
        );
        const statusData = await statusResponse.json();

        if (statusData.data?.magnets?.links) {
          return statusData.data.magnets.links
            .map((link: DebridLinkEntry) => link.link)
            .filter((link: string | undefined): link is string => Boolean(link));
        }
      }
      return null;
    } else if (debrid.service === "premiumize") {
      const formData = new URLSearchParams();
      formData.append("src", magnetUri);

      const response = await fetch("https://www.premiumize.me/api/transfer/create", {
        method: "POST",
        headers: { Authorization: `Bearer ${debrid.apiKey}` },
        body: formData,
      });
      const data = await response.json();

      if (data.id) {
        await new Promise((resolve) => setTimeout(resolve, 3000));

        const listResponse = await fetch(
          `https://www.premiumize.me/api/transfer/list?apikey=${debrid.apiKey}`
        );
        const listData = await listResponse.json();

        const transfer = (listData.transfers as PremiumizeTransfer[] | undefined)?.find(
          (item) => item.id === data.id
        );
        if (transfer?.folder_id) {
          const folderResponse = await fetch(
            `https://www.premiumize.me/api/folder/list?id=${transfer.folder_id}&apikey=${debrid.apiKey}`
          );
          const folderData = await folderResponse.json();
          return (
            (folderData.content as PremiumizeFolderItem[] | undefined)
              ?.map((item) => item.link)
              .filter((link: string | undefined): link is string => Boolean(link)) || null
          );
        }
      }
      return null;
    }
  } catch (err) {
    console.error("Debrid magnet error:", err);
  }
  return null;
}

export async function convertTorrentFileWithDebrid(
  torrentUrl: string,
  debridConfig: DebridConfig,
  allowRefreshRetry = true
): Promise<string[] | null> {
  let debrid = await ensureValidToken(debridConfig);

  if (!supportsTorrentDebrid(debrid.service)) {
    return null;
  }

  try {
    const remoteTorrent = await fetchRemoteTorrentFile(torrentUrl);

    if (debrid.service === "realdebrid") {
      const formData = new FormData();
      formData.append(
        "file",
        new Blob([new Uint8Array(remoteTorrent.buffer)], { type: "application/x-bittorrent" }),
        remoteTorrent.filename
      );

      const addResponse = await fetch("https://api.real-debrid.com/rest/1.0/torrents/addTorrent", {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
        },
        body: formData,
      });

      const addData = (await addResponse.json().catch(() => null)) as RealDebridTorrentAddResponse | null;
      if (
        addData?.error &&
        (addData.error === "bad_token" || addData.error === "bad_token_check") &&
        debrid.refreshToken &&
        allowRefreshRetry
      ) {
        debrid = await ensureValidToken(debrid, true);
        return convertTorrentFileWithDebrid(torrentUrl, debrid, false);
      }

      if (!addResponse.ok || !addData?.id) {
        throw new Error(addData?.error || `Real-Debrid torrent upload failed (${addResponse.status})`);
      }

      await fetch(`https://api.real-debrid.com/rest/1.0/torrents/selectFiles/${addData.id}`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "files=all",
      });

      await new Promise((resolve) => setTimeout(resolve, 2000));

      const infoResponse = await fetch(`https://api.real-debrid.com/rest/1.0/torrents/info/${addData.id}`, {
        headers: { Authorization: `Bearer ${debrid.apiKey}` },
      });
      const infoData = (await infoResponse.json().catch(() => null)) as RealDebridTorrentInfoResponse | null;

      if (!infoResponse.ok || !infoData?.links?.length) {
        return null;
      }

      const unrestrictedLinks: string[] = [];
      for (const link of infoData.links) {
        const result = await unrestrictLink(link, debrid);
        if (result.url) {
          unrestrictedLinks.push(result.url);
        }
      }

      return unrestrictedLinks.length > 0 ? unrestrictedLinks : null;
    }

    if (debrid.service === "alldebrid") {
      const formData = new FormData();
      formData.append(
        "files[]",
        new Blob([new Uint8Array(remoteTorrent.buffer)], { type: "application/x-bittorrent" }),
        remoteTorrent.filename
      );

      const uploadResponse = await fetch("https://api.alldebrid.com/v4/magnet/upload/file", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
        },
        body: formData,
      });

      const uploadData = (await uploadResponse.json().catch(() => null)) as AllDebridUploadFileResponse | null;
      const uploadedFile = uploadData?.data?.files?.[0];
      if (!uploadResponse.ok || !uploadedFile?.id) {
        throw new Error(getFriendlyDebridError(uploadedFile?.error || uploadData?.error));
      }

      if (!uploadedFile.ready) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      const filesFormData = new FormData();
      filesFormData.append("id[]", String(uploadedFile.id));

      const filesResponse = await fetch("https://api.alldebrid.com/v4/magnet/files", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
        },
        body: filesFormData,
      });

      const filesData = (await filesResponse.json().catch(() => null)) as AllDebridMagnetFilesResponse | null;
      if (filesResponse.ok) {
        const links =
          filesData?.data?.magnets?.flatMap((magnet) =>
            (magnet.files || []).flatMap((file) => flattenAllDebridLinks(file))
          ) || [];

        if (links.length > 0) {
          return links;
        }
      }

      const statusFormData = new FormData();
      statusFormData.append("id", String(uploadedFile.id));
      const statusResponse = await fetch("https://api.alldebrid.com/v4.1/magnet/status", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
        },
        body: statusFormData,
      });

      const statusData = (await statusResponse.json().catch(() => null)) as AllDebridMagnetStatusResponse | null;
      const links =
        statusData?.data?.magnets?.flatMap((magnet) =>
          (magnet.links || [])
            .map((entry) => entry.link)
            .filter((link): link is string => Boolean(link))
        ) || [];

      return links.length > 0 ? links : null;
    }
  } catch (err) {
    console.error("Debrid torrent-file error:", err);
  }

  return null;
}

// Get list of supported hosts from the debrid service
export async function getSupportedHosts(
  debridConfig: DebridConfig
): Promise<{ hosts: string[]; error?: string }> {
  const debrid = await ensureValidToken(debridConfig);

  try {
    if (!debrid.service || !debrid.apiKey) {
      return { hosts: [], error: "No debrid service configured" };
    }

    console.log(`[Debrid] Fetching supported hosts from ${debrid.service}...`);

    if (debrid.service === "realdebrid") {
      // Real-Debrid: GET /hosts
      const response = await fetch("https://api.real-debrid.com/rest/1.0/hosts", {
        headers: { Authorization: `Bearer ${debrid.apiKey}` },
      });

      if (!response.ok) {
        const err = await response.json().catch(() => ({}));
        return { hosts: [], error: `Real-Debrid: ${err.error || response.statusText}` };
      }

      const data = await response.json();
      // Real-Debrid returns an object with host domains as keys
      const hosts = Object.keys(data).filter(h => h && h.includes('.'));
      console.log(`[Debrid] Real-Debrid supports ${hosts.length} hosts`);
      return { hosts };
    } else if (debrid.service === "alldebrid") {
      // AllDebrid: GET /hosts
      const response = await fetch(
        `https://api.alldebrid.com/v4/hosts?agent=limbo&apikey=${debrid.apiKey}`
      );

      if (!response.ok) {
        return { hosts: [], error: `AllDebrid: ${response.statusText}` };
      }

      const data = await response.json();
      if (data.status === "error" || data.error) {
        return { hosts: [], error: `AllDebrid: ${data.error?.message || data.error}` };
      }

      // AllDebrid returns hosts in data.hosts array or object
      let hosts: string[] = [];
      if (data.data?.hosts) {
        if (Array.isArray(data.data.hosts)) {
          hosts = (data.data.hosts as AllDebridHostEntry[])
            .map((host) => host.domain || host.name)
            .filter((host): host is string => Boolean(host));
        } else {
          hosts = Object.values(data.data.hosts as Record<string, AllDebridHostEntry>)
            .map((host) => host.domain || host.domains?.[0])
            .filter((host): host is string => Boolean(host));
        }
      }
      console.log(`[Debrid] AllDebrid supports ${hosts.length} hosts`);
      return { hosts };
    } else if (debrid.service === "premiumize") {
      // Premiumize: GET /services/list
      const response = await fetch(
        `https://www.premiumize.me/api/services/list?apikey=${debrid.apiKey}`
      );

      if (!response.ok) {
        return { hosts: [], error: `Premiumize: ${response.statusText}` };
      }

      const data = await response.json();
      if (data.status !== "success") {
        return { hosts: [], error: `Premiumize: ${data.message || "Unknown error"}` };
      }

      // Premiumize returns services with patterns/hosts
      let hosts: string[] = [];
      if (data.directdl) {
        hosts = data.directdl.filter((h: string) => h && h.includes('.'));
      }
      if (data.cache) {
        hosts = [...hosts, ...data.cache.filter((h: string) => h && h.includes('.'))];
      }
      // Remove duplicates
      hosts = [...new Set(hosts)];
      console.log(`[Debrid] Premiumize supports ${hosts.length} hosts`);
      return { hosts };
    }

    return { hosts: [], error: `Unknown debrid service: ${debrid.service}` };
  } catch (err) {
    console.error("[Debrid] Error fetching supported hosts:", err);
    return { hosts: [], error: `Failed to fetch hosts: ${err}` };
  }
}

export function supportsDebridTorrentFiles(debridConfig: DebridConfig) {
  return supportsTorrentDebrid(debridConfig.service) && Boolean(debridConfig.apiKey);
}
