import type { Metadata } from "next";
import "./styles.css";
import ApiOnlyNotice from "./api-only-notice";

export const metadata: Metadata = {
  title: { default: "Mandate Court", template: "%s · Mandate Court" },
  description: "The neutral adjudication protocol for autonomous economic agreements.",
  icons: { icon: "/icon.svg", shortcut: "/icon.svg", apple: "/icon.svg" },
  openGraph: { title: "Mandate Court", description: "Commitment. Evidence. Judgment. Enforcement.", type: "website" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>
        <div className="grain" />
        <ApiOnlyNotice />
        <header className="topbar">
          <a className="brand" href="/">
            <img src="/icon.svg" alt="" width="38" height="38" />
            <span><strong>Mandate</strong> Court</span>
          </a>
          <nav>
            <a href="/mandates">Docket</a>
            <a href="/explorer">Explorer</a>
            <a href="/agents">Agents</a>
            <a href="/developers">Developers</a>
          </nav>
          <a className="button small" href="/developers#quickstart">Build with Court</a>
        </header>
        <main>{children}</main>
        <footer>
          <div><img src="/icon.svg" alt="" width="28" height="28" /> Mandate Court Protocol</div>
          <span>Base Sepolia · GenLayer StudioNet · Demo fees: 0</span>
        </footer>
      </body>
    </html>
  );
}
