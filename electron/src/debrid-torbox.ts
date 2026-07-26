const TORBOX_API = "https://api.torbox.app/v1";

type TorboxApiResponse<T> = {
  success?: boolean;
  error?: string | null;
  detail?: string | null;
  data?: T;
};

type TorboxTorrentCreateData = {
  hash?: string;
  torrent_id?: number;
  auth_id?: string;
};

type TorboxWebCreateData = {
  hash?: string;
  webdownload_id?: number | string;
  auth_id?: string;
};

type TorboxFile = {
  id?: number;
  name?: string;
  size?: number;
  short_name?: string;
};

type TorboxTorrentInfo = {
  id?: number;
  name?: string;
  download_finished?: boolean;
  download_present?: boolean;
  download_state?: string;
  files?: TorboxFile[];
};

type TorboxHoster = {
  name?: string;
  domains?: string[];
  status?: boolean | string;
  url?: string;
};

function authHeaders(apiKey: string): HeadersInit {
  return {
    Authorization: `Bearer ${apiKey}`,
  };
}

function torboxError(payload: TorboxApiResponse<unknown> | null, fallback: string) {
  if (!payload) return fallback;
  if (typeof payload.error === "string" && payload.error) return payload.error;
  if (typeof payload.detail === "string" && payload.detail) return payload.detail;
  return fallback;
}

async function readTorboxJson<T>(response: Response): Promise<TorboxApiResponse<T> | null> {
  return (await response.json().catch(() => null)) as TorboxApiResponse<T> | null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTorrentReady(info: TorboxTorrentInfo | null | undefined) {
  if (!info) return false;
  if (info.download_finished || info.download_present) return true;
  const state = (info.download_state || "").toLowerCase();
  return state.includes("cached") || state.includes("completed") || state.includes("uploading");
}

async function getTorrentInfo(apiKey: string, torrentId: number): Promise<TorboxTorrentInfo | null> {
  const response = await fetch(
    `${TORBOX_API}/api/torrents/mylist?id=${encodeURIComponent(String(torrentId))}&bypass_cache=true`,
    { headers: authHeaders(apiKey) }
  );
  const payload = await readTorboxJson<TorboxTorrentInfo | TorboxTorrentInfo[]>(response);
  if (!response.ok || !payload?.success) {
    throw new Error(torboxError(payload, `TorBox: failed to fetch torrent (${response.status})`));
  }

  if (Array.isArray(payload.data)) {
    return payload.data.find((item) => item.id === torrentId) || payload.data[0] || null;
  }
  return payload.data || null;
}

async function getWebDownloadInfo(apiKey: string, webId: number): Promise<TorboxTorrentInfo | null> {
  const response = await fetch(
    `${TORBOX_API}/api/webdl/mylist?id=${encodeURIComponent(String(webId))}&bypass_cache=true`,
    { headers: authHeaders(apiKey) }
  );
  const payload = await readTorboxJson<TorboxTorrentInfo | TorboxTorrentInfo[]>(response);
  if (!response.ok || !payload?.success) {
    throw new Error(torboxError(payload, `TorBox: failed to fetch web download (${response.status})`));
  }

  if (Array.isArray(payload.data)) {
    return payload.data.find((item) => item.id === webId) || payload.data[0] || null;
  }
  return payload.data || null;
}

async function waitForTorrentReady(
  apiKey: string,
  torrentId: number,
  attempts = 12,
  delayMs = 2500
): Promise<TorboxTorrentInfo> {
  let last: TorboxTorrentInfo | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await getTorrentInfo(apiKey, torrentId);
    if (isTorrentReady(last)) return last!;
    await sleep(delayMs);
  }
  throw new Error(
    last?.download_state
      ? `TorBox: torrent not ready yet (${last.download_state})`
      : "TorBox: torrent not ready yet"
  );
}

async function waitForWebDownloadReady(
  apiKey: string,
  webId: number,
  attempts = 12,
  delayMs = 2500
): Promise<TorboxTorrentInfo> {
  let last: TorboxTorrentInfo | null = null;
  for (let i = 0; i < attempts; i++) {
    last = await getWebDownloadInfo(apiKey, webId);
    if (isTorrentReady(last)) return last!;
    await sleep(delayMs);
  }
  throw new Error(
    last?.download_state
      ? `TorBox: web download not ready yet (${last.download_state})`
      : "TorBox: web download not ready yet"
  );
}

async function requestTorrentFileLink(
  apiKey: string,
  torrentId: number,
  fileId: number
): Promise<string | null> {
  const params = new URLSearchParams({
    token: apiKey,
    torrent_id: String(torrentId),
    file_id: String(fileId),
  });
  const response = await fetch(`${TORBOX_API}/api/torrents/requestdl?${params.toString()}`);
  const payload = await readTorboxJson<string>(response);
  if (!response.ok || !payload?.success || typeof payload.data !== "string" || !payload.data) {
    return null;
  }
  return payload.data;
}

async function requestWebFileLink(
  apiKey: string,
  webId: number,
  fileId?: number
): Promise<string | null> {
  const params = new URLSearchParams({
    token: apiKey,
    web_id: String(webId),
  });
  if (fileId != null) {
    params.set("file_id", String(fileId));
  } else {
    params.set("zip_link", "true");
  }
  const response = await fetch(`${TORBOX_API}/api/webdl/requestdl?${params.toString()}`);
  const payload = await readTorboxJson<string>(response);
  if (!response.ok || !payload?.success || typeof payload.data !== "string" || !payload.data) {
    return null;
  }
  return payload.data;
}

async function collectTorrentLinks(apiKey: string, torrentId: number): Promise<string[]> {
  const info = await waitForTorrentReady(apiKey, torrentId);
  const files = info.files || [];
  if (files.length === 0) {
    // Fall back to zip permalink-style request when file list is empty.
    const params = new URLSearchParams({
      token: apiKey,
      torrent_id: String(torrentId),
      zip_link: "true",
    });
    const response = await fetch(`${TORBOX_API}/api/torrents/requestdl?${params.toString()}`);
    const payload = await readTorboxJson<string>(response);
    if (payload?.success && typeof payload.data === "string" && payload.data) {
      return [payload.data];
    }
    return [];
  }

  const links: string[] = [];
  for (const file of files) {
    if (file.id == null) continue;
    const link = await requestTorrentFileLink(apiKey, torrentId, file.id);
    if (link) links.push(link);
  }
  return links;
}

export async function unrestrictWithTorbox(
  url: string,
  apiKey: string
): Promise<{ url: string | null; error?: string }> {
  try {
    const form = new FormData();
    form.append("link", url);

    const createResponse = await fetch(`${TORBOX_API}/api/webdl/createwebdownload`, {
      method: "POST",
      headers: authHeaders(apiKey),
      body: form,
    });
    const createPayload = await readTorboxJson<TorboxWebCreateData>(createResponse);
    const webIdRaw = createPayload?.data?.webdownload_id;
    const webId = typeof webIdRaw === "string" ? Number.parseInt(webIdRaw, 10) : webIdRaw;

    if (!createResponse.ok || !createPayload?.success || !webId || !Number.isFinite(webId)) {
      return {
        url: null,
        error: `TorBox: ${torboxError(createPayload, "failed to create web download")}`,
      };
    }

    const info = await waitForWebDownloadReady(apiKey, webId);
    const firstFileId = info.files?.[0]?.id;
    const link = await requestWebFileLink(apiKey, webId, firstFileId);
    if (!link) {
      return { url: null, error: "TorBox: No download link returned." };
    }
    return { url: link };
  } catch (error) {
    return {
      url: null,
      error: `TorBox: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function convertMagnetWithTorbox(
  magnetUri: string,
  apiKey: string
): Promise<string[] | null> {
  const form = new FormData();
  form.append("magnet", magnetUri);

  const createResponse = await fetch(`${TORBOX_API}/api/torrents/createtorrent`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  const createPayload = await readTorboxJson<TorboxTorrentCreateData>(createResponse);
  const torrentId = createPayload?.data?.torrent_id;

  if (!createResponse.ok || !createPayload?.success || torrentId == null) {
    throw new Error(torboxError(createPayload, `TorBox: failed to add magnet (${createResponse.status})`));
  }

  const links = await collectTorrentLinks(apiKey, torrentId);
  return links.length > 0 ? links : null;
}

export async function convertTorrentFileWithTorbox(
  buffer: Buffer,
  filename: string,
  apiKey: string
): Promise<string[] | null> {
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(buffer)], { type: "application/x-bittorrent" }),
    filename
  );

  const createResponse = await fetch(`${TORBOX_API}/api/torrents/createtorrent`, {
    method: "POST",
    headers: authHeaders(apiKey),
    body: form,
  });
  const createPayload = await readTorboxJson<TorboxTorrentCreateData>(createResponse);
  const torrentId = createPayload?.data?.torrent_id;

  if (!createResponse.ok || !createPayload?.success || torrentId == null) {
    throw new Error(
      torboxError(createPayload, `TorBox: failed to upload torrent (${createResponse.status})`)
    );
  }

  const links = await collectTorrentLinks(apiKey, torrentId);
  return links.length > 0 ? links : null;
}

export async function getTorboxSupportedHosts(
  apiKey: string
): Promise<{ hosts: string[]; error?: string }> {
  try {
    const response = await fetch(`${TORBOX_API}/api/webdl/hosters`, {
      headers: authHeaders(apiKey),
    });
    const payload = await readTorboxJson<TorboxHoster[]>(response);
    if (!response.ok || !payload?.success || !Array.isArray(payload.data)) {
      return {
        hosts: [],
        error: `TorBox: ${torboxError(payload, response.statusText || "failed to fetch hosts")}`,
      };
    }

    const hosts = payload.data
      .filter((host) => host.status === true || host.status === "up" || host.status === "green")
      .flatMap((host) => host.domains || [])
      .filter((domain): domain is string => Boolean(domain && domain.includes(".")));

    return { hosts: [...new Set(hosts)] };
  } catch (error) {
    return {
      hosts: [],
      error: `TorBox: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
