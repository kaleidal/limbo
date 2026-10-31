import { commands } from "@/lib/bindings";
import { useAppStore } from "@/store/app-store";

export function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function isVpnRequired(error: unknown) {
  return errorMessage(error).includes("VPN_REQUIRED");
}

export function isMagnet(url: string) {
  return url.startsWith("magnet:");
}

export function magnetName(magnet: string) {
  const name = new URLSearchParams(magnet.slice(magnet.indexOf("?") + 1)).get("dn");
  return name?.trim() || "Magnet link";
}

export function hostnameOf(input: string) {
  try {
    return new URL(input.startsWith("http") ? input : `https://${input}`).hostname;
  } catch {
    return input;
  }
}

export function faviconFor(input: string) {
  return `https://www.google.com/s2/favicons?domain=${hostnameOf(input)}&sz=64`;
}

export async function addTorrentFile(path: string) {
  const store = useAppStore.getState();
  store.showDownloads("torrents");
  try {
    await commands.torrentsAddFile({ path });
  } catch (error) {
    if (isVpnRequired(error)) store.setVpnRequired(true);
    else console.error("Failed to add torrent file:", error);
  }
}

export function pathFromFileUrl(url: string) {
  const path = decodeURIComponent(new URL(url).pathname);
  return /^\/[A-Za-z]:\//.test(path) ? path.slice(1) : path;
}
