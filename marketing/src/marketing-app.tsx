import { ArrowDownToLine, ArrowRight, CodeXml, Library, Link2, Magnet, MonitorDown } from "lucide-react"
import { useEffect, useState } from "react"

import previewUrl from "../../preview.png"

const releaseRoot = "https://github.com/kaleidal/limbo/releases/latest"
const releaseApi = "https://api.github.com/repos/kaleidal/limbo/releases/latest"

type Downloads = {
  windows: string
  macArm: string
  macIntel: string
  linux: string
}

type LatestRelease = {
  version: string
  downloads: Downloads
}

type GitHubRelease = {
  tag_name: string
  html_url: string
  assets: Array<{ name: string; browser_download_url: string }>
}

const releaseFallback: LatestRelease = {
  version: "latest",
  downloads: {
    windows: releaseRoot,
    macArm: releaseRoot,
    macIntel: releaseRoot,
    linux: releaseRoot,
  },
}

let latestReleaseRequest: Promise<LatestRelease> | undefined

function latestRelease() {
  latestReleaseRequest ??= fetch(releaseApi, {
    headers: { Accept: "application/vnd.github+json" },
  }).then(async (response) => {
    if (!response.ok) throw new Error(`GitHub release lookup failed (${response.status})`)
    const release = (await response.json()) as GitHubRelease
    const asset = (suffix: string) => {
      const match = release.assets.find(({ name }) => name.endsWith(suffix))
      if (!match) throw new Error(`Latest Limbo release is missing ${suffix}`)
      return match.browser_download_url
    }
    return {
      version: release.tag_name.replace(/^v/, ""),
      downloads: {
        windows: asset("-msi-windows-x86_64-msi.msi"),
        macArm: asset("-dmg-macos-aarch64-dmg.dmg"),
        macIntel: asset("-dmg-macos-x86_64-dmg.dmg"),
        linux: asset("-appimage-linux-x86_64-appimage.AppImage"),
      },
    }
  })
  return latestReleaseRequest
}

function preferredDownload(downloads: Downloads) {
  if (typeof navigator === "undefined") return { label: "Download Limbo", href: releaseRoot }
  const platform = `${navigator.userAgent} ${navigator.platform}`.toLowerCase()
  if (platform.includes("windows")) return { label: "Download for Windows", href: downloads.windows }
  if (platform.includes("mac")) return { label: "Download for macOS", href: downloads.macArm }
  if (platform.includes("linux")) return { label: "Download for Linux", href: downloads.linux }
  return { label: "Download Limbo", href: releaseRoot }
}

const flow = [
  { icon: Link2, title: "Give it a link", copy: "Paste a direct URL, magnet, or torrent file. Limbo recognizes the route and gets moving." },
  { icon: MonitorDown, title: "Keep the transfer visible", copy: "Pause, resume, reprioritize, or hand the job to your Debrid provider without losing the thread." },
  { icon: Library, title: "Find it later", copy: "Finished files land in a local library built for software, media, archives, and everything between." },
]

export function MarketingApp() {
  const [release, setRelease] = useState(releaseFallback)

  useEffect(() => {
    let current = true
    void latestRelease().then(
      (latest) => current && setRelease(latest),
      () => undefined,
    )
    return () => {
      current = false
    }
  }, [])

  const { downloads } = release
  const primary = preferredDownload(downloads)

  return (
    <div className="site-shell">
      <header className="site-header">
        <a className="brand" href="#top" aria-label="Limbo home">
          <img src="/limbo.svg" alt="" />
          <span>Limbo</span>
        </a>
        <nav aria-label="Main navigation">
          <a href="#flow">How it works</a>
          <a href="#download">Download</a>
          <a href="https://github.com/kaleidal/limbo">GitHub</a>
        </nav>
      </header>

      <main id="top">
        <section className="hero">
          <div className="hero-copy">
            <h1>Everything you download, <span>out of limbo.</span></h1>
            <p>Direct links, torrents, Debrid services, and your local files in one focused desktop app.</p>
            <div className="hero-actions">
              <a className="primary-action" href={primary.href}>
                <ArrowDownToLine aria-hidden="true" />
                {primary.label}
              </a>
              <a className="text-action" href="https://github.com/kaleidal/limbo">
                <CodeXml aria-hidden="true" />
                View source
              </a>
            </div>
            <p className="release-note">Limbo {release.version} · Windows, macOS, and Linux</p>
          </div>

          <div className="product-stage" aria-label="Limbo desktop application preview">
            <div className="stage-rule" />
            <div className="transfer-readout" aria-hidden="true">
              <strong>linux-image.iso</strong>
              <div><i /><b>72%</b></div>
              <small>8.6 MB/s&nbsp;&nbsp; 1m 42s left</small>
            </div>
            <div className="app-window">
              <img src={previewUrl} alt="Limbo library showing locally managed downloads" />
            </div>
          </div>
        </section>

        <section className="capability-line" aria-label="Supported download methods">
          <span><ArrowDownToLine aria-hidden="true" />Direct</span>
          <span><Magnet aria-hidden="true" />Torrents</span>
          <span><Link2 aria-hidden="true" />Debrid</span>
          <span><Library aria-hidden="true" />Local library</span>
        </section>

        <section className="flow" id="flow">
          <div className="section-intro">
            <h2>One route from link to library.</h2>
          </div>
          <ol>
            {flow.map(({ icon: Icon, title, copy }, index) => (
              <li key={title}>
                <span className="step-number">0{index + 1}</span>
                <Icon aria-hidden="true" />
                <div>
                  <h3>{title}</h3>
                  <p>{copy}</p>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <section className="download" id="download">
          <div className="download-lead">
            <h2>Ready when the link is.</h2>
            <p>Free and open source. The first launch downloads Limbo’s shared Chromium runtime.</p>
          </div>
          <div className="platforms">
            <a href={downloads.windows}><span>Windows</span><small>64-bit · MSI</small><ArrowRight aria-hidden="true" /></a>
            <a href={downloads.macArm}><span>macOS Apple silicon</span><small>ARM64 · DMG</small><ArrowRight aria-hidden="true" /></a>
            <a href={downloads.macIntel}><span>macOS Intel</span><small>x86-64 · DMG</small><ArrowRight aria-hidden="true" /></a>
            <a href={downloads.linux}><span>Linux</span><small>x86-64 · AppImage</small><ArrowRight aria-hidden="true" /></a>
          </div>
          <p className="unsigned-note">Windows and macOS builds are currently unsigned. Your system may ask you to confirm the first launch.</p>
        </section>
      </main>

      <footer>
        <div className="brand"><img src="/limbo.svg" alt="" /><span>Limbo</span></div>
        <p>A general-purpose download and organization tool. Use it only for content you have the right to access.</p>
        <a href="https://github.com/kaleidal/limbo">Source on GitHub <ArrowRight aria-hidden="true" /></a>
      </footer>
    </div>
  )
}
