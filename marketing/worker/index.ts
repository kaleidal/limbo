const releases = "https://dl.schelf.store/kaleidal/limbo"

const targets = new Map([
  ["/download/windows", "windows-x86_64/msi"],
  ["/download/macos", "macos-aarch64/dmg"],
  ["/download/linux", "linux-x86_64/app-image"],
])

export default {
  async fetch(request) {
    const path = new URL(request.url).pathname
    const target = targets.get(path)
    if (!target && path !== "/api/release") return new Response("Not found", { status: 404 })
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, HEAD" } })
    }
    if (target) {
      return new Response(null, {
        status: 302,
        headers: { Location: `${releases}/latest/${target}`, "Cache-Control": "no-store" },
      })
    }

    try {
      const response = await fetch(`${releases}/latest.json`, {
        cf: { cacheEverything: true, cacheTtlByStatus: { "200-399": 60, "400-599": 0 } },
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) throw new Error(`Release lookup returned ${response.status}`)
      const { version } = await response.json<{ version: string }>()
      return new Response(request.method === "HEAD" ? null : JSON.stringify({ version }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "public, max-age=60" },
      })
    } catch (error) {
      console.error("Release lookup failed", { error: String(error) })
      return new Response("The release is temporarily unavailable. Please try again shortly.", {
        status: 503,
        headers: { "Cache-Control": "no-store", "Retry-After": "60" },
      })
    }
  },
} satisfies ExportedHandler
