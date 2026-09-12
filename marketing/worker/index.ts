const manifestUrl = "https://github.com/kaleidal/limbo/releases/latest/download/sabine-update.json"

const targets = new Map([
  ["/download/windows", "windows-x86_64-msi"],
  ["/download/macos", "macos-aarch64-dmg"],
  ["/download/linux", "linux-x86_64-appimage"],
])

type Release = {
  version: string
  artifacts: Record<string, { url: string }>
}

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    const target = targets.get(path)
    if (!target && path !== "/api/release") return new Response("Not found", { status: 404 })
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } })
    }

    try {
      const response = await fetch(manifestUrl, {
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-399": 60, "400-599": 0 } },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Release lookup returned ${response.status}`)
      const release = await response.json<Release>()
      if (!target) {
        return new Response(request.method === "HEAD" ? null : JSON.stringify({ version: release.version }), {
          headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
        })
      }

      const artifact = release.artifacts[target]
      if (!artifact) throw new Error(`Release ${release.version} is missing ${target}`)
      return new Response(null, {
        status: 302,
        headers: { Location: artifact.url, "Cache-Control": "no-store" },
      })
    } catch (error) {
      console.error("Release download lookup failed", { path, error: String(error) })
      return new Response("The download is temporarily unavailable. Please try again shortly.", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      })
    }
  },
} satisfies ExportedHandler
