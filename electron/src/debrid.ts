// Debrid service integration (Real-Debrid, AllDebrid, Premiumize)

import type { DebridConfig, DebridResult } from "./types.js";

// Unrestrict a link using debrid service
export async function unrestrictLink(url: string, debrid: DebridConfig): Promise<DebridResult> {
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
  debrid: DebridConfig
): Promise<string[] | null> {
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
