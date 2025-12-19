// File host detection and link extraction
const FILE_HOST_EXTRACTORS = [
    {
        name: "rapidgator",
        pattern: /rapidgator\.net/i,
        extract: (html) => {
            const directMatch = html.match(/var\s+download_url\s*=\s*['"]([^'"]+)['"]/i);
            if (directMatch)
                return directMatch[1];
            const formMatch = html.match(/<form[^>]*action=['"]([^'"]*download[^'"]*)['"]/i);
            if (formMatch)
                return formMatch[1];
            return null;
        },
    },
    {
        name: "mediafire",
        pattern: /mediafire\.com/i,
        extract: (html) => {
            const match = html.match(/href=['"]([^'"]*download[^'"]*\.mediafire\.com[^'"]+)['"]/i);
            if (match)
                return match[1];
            const altMatch = html.match(/aria-label=['"]Download file['"]\s+href=['"]([^'"]+)['"]/i);
            if (altMatch)
                return altMatch[1];
            const btnMatch = html.match(/id=['"]downloadButton['"]\s+href=['"]([^'"]+)['"]/i);
            return btnMatch?.[1] || null;
        },
    },
    {
        name: "1fichier",
        pattern: /1fichier\.com/i,
        extract: (html) => {
            const match = html.match(/href=['"]([^'"]+\.1fichier\.com\/[^'"]+)['"]/i);
            return match?.[1] || null;
        },
    },
    {
        name: "uploadgig",
        pattern: /uploadgig\.com/i,
        extract: (html) => {
            const match = html.match(/href=['"]([^'"]*download[^'"]+uploadgig[^'"]+)['"]/i);
            return match?.[1] || null;
        },
    },
    {
        name: "katfile",
        pattern: /katfile\.com/i,
        extract: (html) => {
            const match = html.match(/href=['"]([^'"]*\.katfile\.com\/[a-zA-Z0-9]+\/[^'"]+)['"]/i);
            return match?.[1] || null;
        },
    },
    {
        name: "nitroflare",
        pattern: /nitroflare\.com/i,
        extract: (html) => {
            const match = html.match(/https?:\/\/[a-z0-9]+\.nitroflare\.com\/[^\s'"<>]+/i);
            return match?.[0] || null;
        },
    },
];
// Check if a URL is a file host landing page
export function isFileHostUrl(url) {
    return FILE_HOST_EXTRACTORS.some((e) => e.pattern.test(url));
}
// Extract direct download link from file host page
export async function extractFileHostLink(url) {
    const extractor = FILE_HOST_EXTRACTORS.find((e) => e.pattern.test(url));
    if (!extractor)
        return null;
    try {
        console.log(`[FileHost] Fetching ${extractor.name} page: ${url}`);
        const response = await fetch(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
                "Accept-Language": "en-US,en;q=0.5",
            },
        });
        if (!response.ok) {
            console.error(`[FileHost] Failed to fetch: ${response.status}`);
            return null;
        }
        const html = await response.text();
        const directLink = extractor.extract(html, url);
        if (directLink) {
            console.log(`[FileHost] Extracted link from ${extractor.name}: ${directLink}`);
            return directLink;
        }
        console.log(`[FileHost] No direct link found in ${extractor.name} page`);
        return null;
    }
    catch (err) {
        console.error(`[FileHost] Error extracting from ${extractor.name}:`, err);
        return null;
    }
}
// URL patterns for clipboard monitoring
const DOWNLOAD_PATTERNS = [
    /^magnet:\?/i,
    /\.(rar|zip|7z|tar|gz|iso|exe|msi|dmg|pkg|deb|rpm)(\?.*)?$/i,
    /rapidgator\.net/i,
    /nitroflare\.com/i,
    /uploadgig\.com/i,
    /1fichier\.com/i,
    /mega\.nz/i,
    /mediafire\.com/i,
    /turbobit\.net/i,
    /katfile\.com/i,
    /filefactory\.com/i,
];
export function isDownloadableUrl(text) {
    if (!text || text.length < 5 || text.length > 2000)
        return false;
    try {
        if (text.startsWith("magnet:"))
            return true;
        const url = new URL(text);
        if (!["http:", "https:"].includes(url.protocol))
            return false;
        return DOWNLOAD_PATTERNS.some((pattern) => pattern.test(text));
    }
    catch {
        return false;
    }
}
