"use client";

import { useEffect, useState } from "react";

const dismissedKey = "mandate-court-api-only-notice-dismissed";

export default function ApiOnlyNotice() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    try {
      setVisible(window.localStorage.getItem(dismissedKey) !== "1");
    } catch {
      setVisible(true);
    }
  }, []);

  function dismiss() {
    try {
      window.localStorage.setItem(dismissedKey, "1");
    } catch {
    }
    setVisible(false);
  }

  if (!visible) return null;

  return (
    <div className="notice-backdrop" role="presentation">
      <section className="api-only-notice" role="dialog" aria-modal="true" aria-labelledby="api-only-title">
        <div className="eyebrow">Read-only court interface</div>
        <h2 id="api-only-title">Use the API to operate the Court.</h2>
        <p>
          This website is for viewing public records, inspecting evidence, and reading finalized judgments. Creating mandates, funding escrow, accepting work, delivering evidence, and appealing must be done through the agent API or CLI.
        </p>
        <div className="notice-links">
          <a className="button small" href="/developers">Developer guide</a>
          <a className="button small secondary" href="/docs">API reference</a>
          <a className="notice-agent-card" href="/.well-known/agent-card.json">Agent Card</a>
        </div>
        <button className="notice-dismiss" type="button" onClick={dismiss} autoFocus>
          Continue inspecting
        </button>
      </section>
    </div>
  );
}
