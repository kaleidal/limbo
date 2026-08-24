import { ArrowDownToLine, ArrowRight, CodeXml, Library, Link2, Magnet, MonitorDown } from "lucide-react"

import previewUrl from "../../preview.png"

const releaseRoot = "https://github.com/kaleidal/limbo/releases/latest"
const downloadRoot = `${releaseRoot}/download`

const downloads = {
  windows: `${downloadRoot}/al.kaleid.limbo-1.4.0-msi-windows-x86_64-msi.msi`,
  macArm: `${downloadRoot}/al.kaleid.limbo-1.4.0-dmg-macos-aarch64-dmg.dmg`,
  macIntel: `${downloadRoot}/al.kaleid.limbo-1.4.0-dmg-macos-x86_64-dmg.dmg`,
  linux: `${downloadRoot}/al.kaleid.limbo-1.4.0-appimage-linux-x86_64-appimage.AppImage`,
}

function preferredDownload() {
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
  const primary = preferredDownload()

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
            <h1>Everything you download,<br /><span>out of limbo.</span></h1>
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
            <p className="release-note">Limbo 1.4.0 · Windows, macOS, and Linux</p>
          </div>

          <div className="product-stage" aria-label="Limbo desktop application preview">
            <div className="stage-rule" />
            <div className="transfer-readout" aria-hidden="true">
              <span>ACTIVE TRANSFER</span>
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
            <p>One route from link to library.</p>
            <h2>Built around the job,<br />not the protocol.</h2>
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
            <a href={downloads.macArm}><span>macOS</span><small>Apple silicon · DMG</small><ArrowRight aria-hidden="true" /></a>
            <a href={downloads.macIntel}><span>macOS</span><small>Intel · DMG</small><ArrowRight aria-hidden="true" /></a>
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
