"use client";

/**
 * The unlock page.
 *
 * Says why the gate exists rather than presenting a bare box. A reviewer who was sent a
 * link and meets an unexplained password field reasonably wonders whether they are in the
 * right place.
 */
import { useCallback, useState } from "react";

export default function Unlock() {
  const [passcode, setPasscode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/unlock", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ passcode }),
        });
        if (res.ok) window.location.href = "/";
        else setError(((await res.json()) as { error?: string }).error ?? "Unlock failed.");
      } catch {
        setError("Unlock failed.");
      } finally {
        setBusy(false);
      }
    },
    [passcode],
  );

  return (
    <main style={{ maxWidth: "26rem" }}>
      <h1>Regulatory change intelligence</h1>
      <div className="help" style={{ marginTop: 0 }}>
        This instance is passphrase-protected. Analysis calls a paid model API, so the link is
        not left open.
      </div>

      <form onSubmit={submit}>
        <input
          type="password"
          value={passcode}
          onChange={(e) => setPasscode(e.target.value)}
          placeholder="Passphrase"
          aria-label="Passphrase"
          autoFocus
        />
        <button type="submit" disabled={busy || passcode.trim() === ""}>
          {busy ? "Checking…" : "Unlock"}
        </button>
      </form>

      {error && (
        <div className="panel err" style={{ marginTop: "1rem" }}>
          {error}
        </div>
      )}
    </main>
  );
}
