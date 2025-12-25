// Debrid service integration (Real-Debrid, AllDebrid, Premiumize)

import type { DebridConfig, DebridResult } from "./types.js";
import { store } from "./store.js";

// Check and refresh token if needed
async function ensureValidToken(debrid: DebridConfig): Promise<DebridConfig> {
  if (debrid.service !== "realdebrid") return debrid;

  // If no expiry or no refresh token, we can't refresh
  if (!debrid.expiresAt || !debrid.refreshToken || !debrid.clientId || !debrid.clientSecret) {
    return debrid;
  }

  // Buffer of 5 minutes
  if (Date.now() < debrid.expiresAt - 5 * 60 * 1000) {
    return debrid;
  }

  console.log(`[Debrid] Token expiring soon (or expired), refreshing...`);

  try {
    const form = new URLSearchParams();
    form.set("client_id", debrid.clientId);
    form.set("client_secret", debrid.clientSecret);
    form.set("refresh_token", debrid.refreshToken);
    form.set("grant_type", "http://oauth.net/grant_type/device/1.0");

    const response = await fetch("https://api.real-debrid.com/oauth/v2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    });

    if (!response.ok) {
      console.error(`[Debrid] Token refresh failed: ${response.status} ${response.statusText}`);
      return debrid;
    }

    const data = await response.json();
    if (data.access_token && data.refresh_token) {
      console.log(`[Debrid] Token refreshed successfully`);

      const newConfig: DebridConfig = {
        ...debrid,
        apiKey: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: Date.now() + (data.expires_in * 1000),
      };

      // Save to store
      const settings = store.get("settings");
      store.set("settings", {
        ...settings,
        debrid: newConfig,
      });

      return newConfig;
    }
  } catch (err) {
    console.error(`[Debrid] Token refresh error:`, err);
  }

  return debrid;
}

// Unrestrict a link using debrid service
export async function unrestrictLink(url: string, debridConfig: DebridConfig): Promise<DebridResult> {
  const debrid = await ensureValidToken(debridConfig);

  try {
    console.log(`[Debrid] Attempting to unrestrict link via ${debrid.service}: ${url}`);

    if (debrid.service === "realdebrid") {
      const response = await fetch("https://api.real-debrid.com/rest/1.0/unrestrict/link", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${debrid.apiKey}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: `link=${encodeURIComponent(url)}`,
      });
      const data = await response.json();

      if (data.error) {
        console.error(`[Debrid] Real-Debrid error: ${data.error} (code: ${data.error_code})`);
        let friendlyError = data.error;
        if (data.error.startsWith("ip_not_allowed")) {
          friendlyError = "Real-Debrid: IP not allowed. Regenerate API key from current IP or disable VPN.";
        } else if (data.error === "hoster_unavailable" || data.error === "link_host_not_supported") {
          friendlyError = "Real-Debrid: This file host is not supported.";
        } else if (data.error === "bad_token" || data.error === "bad_token_check") {
          // If we get a bad token error despite check, it might be revoked or we might be out of sync.
          // For now, just return error, but in future we could force-clear auth.
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
          return statusData.data.magnets.links.map((l: any) => l.link);
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

        const transfer = listData.transfers?.find((t: any) => t.id === data.id);
        if (transfer?.folder_id) {
          const folderResponse = await fetch(
            `https://www.premiumize.me/api/folder/list?id=${transfer.folder_id}&apikey=${debrid.apiKey}`
          );
          const folderData = await folderResponse.json();
          return folderData.content?.filter((f: any) => f.link).map((f: any) => f.link) || null;
        }
      }
      return null;
    }
  } catch (err) {
    console.error("Debrid magnet error:", err);
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
          hosts = data.data.hosts.map((h: any) => h.domain || h.name || h).filter(Boolean);
        } else {
          // Object form: keys are host IDs, values have domain property
          hosts = Object.values(data.data.hosts)
            .map((h: any) => h.domain || h.domains?.[0])
            .filter(Boolean);
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
