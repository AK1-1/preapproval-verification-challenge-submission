import React, { useEffect, useState, useRef, useCallback } from "react";

const STATUS_CLASS = {
  Met: "met",
  "Not Met": "notmet",
  "Needs Review": "review",
  Internal: "internal",
};

async function api(path, options) {
  const res = await fetch(path, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `${res.status} ${res.statusText}`);
  }
  return res.json();
}

function Badge({ status }) {
  return <span className={`badge ${STATUS_CLASS[status] || "internal"}`}>{status}</span>;
}

// ---------------- Dashboard ----------------
function Dashboard({ onOpenReport, onRunStarted }) {
  const [samples, setSamples] = useState([]);
  const [reports, setReports] = useState([]);
  const [error, setError] = useState("");
  const fileInput = useRef();

  const refresh = useCallback(() => {
    api("/api/samples").then(setSamples).catch((e) => setError(e.message));
    api("/api/reports").then(setReports).catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const run = async (file) => {
    setError("");
    try {
      const { jobId } = await api("/api/verify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file }),
      });
      onRunStarted(jobId);
    } catch (e) {
      setError(e.message);
    }
  };

  const uploadAndRun = async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    setError("");
    try {
      const fd = new FormData();
      fd.append("file", f);
      const { file } = await api("/api/upload", { method: "POST", body: fd });
      await run(file);
    } catch (err) {
      setError(err.message);
    } finally {
      e.target.value = "";
    }
  };

  const reportIds = new Set(reports.map((r) => r.id));

  return (
    <div className="dashboard">
      <section className="panel">
        <h2>Run a verification</h2>
        <p className="hint">
          Pick a sample application, or upload a completed pre-approval form (PDF). The tool reads the form,
          researches the provider's website, captures date-stamped evidence, and builds a review-ready report.
        </p>
        {error && <div className="error">{error}</div>}
        <button className="primary" onClick={() => fileInput.current?.click()}>
          Upload application PDF…
        </button>
        <input ref={fileInput} type="file" accept="application/pdf" hidden onChange={uploadAndRun} />
        <h3>Sample applications</h3>
        <ul className="filelist">
          {samples.map((s) => (
            <li key={s.file}>
              <span className="filename">{s.file}</span>
              <span>
                {reportIds.has(s.reportId) && (
                  <button className="link" onClick={() => onOpenReport(s.reportId)}>
                    open report
                  </button>
                )}
                <button onClick={() => run(`samples/${s.file}`)}>Verify</button>
              </span>
            </li>
          ))}
        </ul>
      </section>

      <section className="panel">
        <h2>Reports</h2>
        {reports.length === 0 && <p className="hint">No reports yet — run a verification.</p>}
        <ul className="filelist">
          {reports.map((r) => (
            <li key={r.id}>
              <span>
                <strong>{r.participant}</strong> — {r.requested} <em>({r.category})</em>
                <div className="hint">{r.reviewDate}{r.needsClarification ? " · ⚠ needs clarification" : ""}</div>
              </span>
              <span>
                <a href={`/reports/${r.id}/index.html`} target="_blank" rel="noreferrer" className="link">
                  shareable HTML
                </a>
                <button onClick={() => onOpenReport(r.id)}>Open</button>
              </span>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}

// ---------------- Job progress ----------------
function JobView({ jobId, onDone, onCancelView }) {
  const [job, setJob] = useState(null);
  useEffect(() => {
    const iv = setInterval(async () => {
      try {
        const j = await api(`/api/jobs/${jobId}`);
        setJob(j);
        if (j.status !== "running") {
          clearInterval(iv);
          if (j.status === "done") onDone(j.reportId);
        }
      } catch {
        clearInterval(iv);
      }
    }, 1500);
    return () => clearInterval(iv);
  }, [jobId, onDone]);

  return (
    <div className="panel jobview">
      <h2>
        Verification in progress <span className="spinner" />
      </h2>
      <pre className="joblog">
        {(job?.log || []).map((l) => `${l.t.slice(11, 19)}  ${l.msg}`).join("\n") || "starting..."}
      </pre>
      {job?.status === "failed" && (
        <div className="error">
          Failed: {job.error} <button onClick={onCancelView}>back</button>
        </div>
      )}
    </div>
  );
}

// ---------------- Report view ----------------
function ReportView({ reportId, onBack, onRunStarted }) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState("");
  const load = useCallback(
    () => api(`/api/reports/${reportId}`).then(setReport).catch((e) => setError(e.message)),
    [reportId]
  );
  // Wrap: load returns a Promise, and a value returned from useEffect is
  // treated as the cleanup function — returning a Promise crashes React on
  // unmount ("destroy is not a function"), blanking the whole app.
  useEffect(() => {
    load();
  }, [load]);

  if (error) return <div className="error">{error}</div>;
  if (!report) return <div className="hint">Loading report…</div>;

  const { parsed, category, findings, rateComparison, internalItems, pages, meta, appealAssessment } = report;
  const internals = (internalItems || []).filter((i) => !i.websiteVerifiable);

  return (
    <div className="reportlayout">
      <div className="reportmain">
        <button className="link" onClick={onBack}>
          ← back to dashboard
        </button>
        <div className="panel">
          <h2>
            {parsed.participantName} — {parsed.requestedItem}
          </h2>
          <table className="kv">
            <tbody>
              <tr><td>Provider</td><td>{parsed.providerName}</td></tr>
              <tr><td>Category</td><td>{category.label}</td></tr>
              <tr><td>Website</td><td><a href={parsed.url} target="_blank" rel="noreferrer">{parsed.url}</a></td></tr>
              <tr><td>Fee on form</td><td>{parsed.statedFee}</td></tr>
              <tr><td>Review date</td><td>{meta.reviewDate}</td></tr>
            </tbody>
          </table>
          {(parsed.missingInfo || []).length > 0 && (
            <div className="error">⚠ {parsed.missingInfo.join(" · ")}</div>
          )}
          <p>
            <a className="link" href={`/reports/${reportId}/index.html`} target="_blank" rel="noreferrer">
              Open shareable HTML report bundle ↗
            </a>
          </p>
        </div>

        {parsed.appeal?.denialReason && (
          <div className="panel appealbox">
            <h3>Appeal — denial reason: “{parsed.appeal.denialReason}”</h3>
            {appealAssessment && <p>{appealAssessment}</p>}
          </div>
        )}

        <div className="panel">
          <h3>Rate comparison</h3>
          <p>
            Form: <strong>{rateComparison?.formRate}</strong> · Website:{" "}
            <strong>{rateComparison?.websiteRate}</strong> ·{" "}
            <Badge
              status={
                rateComparison?.verdict === "matches application exactly"
                  ? "Met"
                  : rateComparison?.verdict === "differs"
                    ? "Not Met"
                    : "Needs Review"
              }
            />{" "}
            {rateComparison?.verdict}
          </p>
          <p className="hint">{rateComparison?.note}</p>
        </div>

        <div className="panel">
          <h3>Website-verifiable findings</h3>
          {(findings || []).map((f) => (
            <details key={f.id} className={`finding ${STATUS_CLASS[f.status]}`}>
              <summary>
                <Badge status={f.status} /> {f.label}
              </summary>
              <div className="findingbody">
                <p>{f.note}</p>
                {f.quote && <blockquote>“{f.quote}”</blockquote>}
                {f.evidenceUrl && (
                  <p className="hint">
                    Source: <a href={f.evidenceUrl} target="_blank" rel="noreferrer">{f.evidenceUrl}</a>
                  </p>
                )}
                {f.targetedScreenshot && (
                  <a href={`/reports/${reportId}/${f.targetedScreenshot}`} target="_blank" rel="noreferrer">
                    <img className="evidence" src={`/reports/${reportId}/${f.targetedScreenshot}`} alt={f.label} />
                  </a>
                )}
              </div>
            </details>
          ))}
        </div>

        <div className="panel">
          <h3>Internal — not website-verifiable ({internals.length})</h3>
          <p className="hint">Left for the human reviewer; answers shown are what the form says.</p>
          {parsed.valuedOutcome && (
            <p>
              <Badge status="Internal" /> Valued outcome (from Life Plan): {parsed.valuedOutcome}
              {parsed.lpDate && <span className="hint"> — LP date {parsed.lpDate}</span>}
            </p>
          )}
          <ul className="internallist">
            {internals.map((i, idx) => (
              <li key={idx}>
                <Badge status="Internal" /> {i.question} <strong>— form says {i.formAnswer}</strong>
              </li>
            ))}
          </ul>
        </div>

        <div className="panel">
          <h3>Whole-page evidence captures</h3>
          <div className="gallery">
            {(pages || [])
              .filter((p) => p.screenshot)
              .map((p, i) => (
                <figure key={i}>
                  <a href={`/reports/${reportId}/${p.screenshot}`} target="_blank" rel="noreferrer">
                    <img src={`/reports/${reportId}/${p.screenshot}`} alt={p.url} />
                  </a>
                  <figcaption>
                    {p.url}
                    <br />
                    <span className="hint">captured {p.capturedAt}{p.blocked ? " · ⚠ looked bot-blocked" : ""}</span>
                  </figcaption>
                </figure>
              ))}
          </div>
        </div>
      </div>

      <ChatSidebar reportId={reportId} onReportChanged={load} onRunStarted={onRunStarted} />
    </div>
  );
}

// ---------------- Chat sidebar ----------------
function ChatSidebar({ reportId, onReportChanged, onRunStarted }) {
  const [messages, setMessages] = useState([
    {
      role: "tool",
      text: "You can adjust this report in plain language — e.g. “Change published fees to Needs Review because the price page looks outdated”, “Add a note that the broker confirmed the rate”, or “Re-run the verification”.",
    },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null); // proposed actions awaiting explicit confirmation
  const logRef = useRef();

  useEffect(() => {
    logRef.current?.scrollTo(0, logRef.current.scrollHeight);
  }, [messages, pending]);

  const send = async () => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    setMessages((m) => [...m, { role: "user", text }]);
    setBusy(true);
    try {
      const res = await api("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, message: text }),
      });
      setMessages((m) => [...m, { role: "tool", text: res.reply }]);
      // Nothing is applied yet — the report only changes after the reviewer
      // confirms the proposed actions below.
      setPending((res.proposedActions || []).length ? res.proposedActions : null);
    } catch (e) {
      setMessages((m) => [...m, { role: "tool", text: `Error: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const confirmPending = async () => {
    if (!pending || busy) return;
    setBusy(true);
    try {
      const res = await api("/api/chat/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reportId, actions: pending }),
      });
      setPending(null);
      setMessages((m) => [
        ...m,
        { role: "tool", text: res.applied?.length ? `Applied:\n• ${res.applied.join("\n• ")}` : "Nothing was applicable to apply." },
      ]);
      if (res.rerunJobId) onRunStarted(res.rerunJobId);
      else if ((res.applied || []).length) onReportChanged();
    } catch (e) {
      setMessages((m) => [...m, { role: "tool", text: `Error applying changes: ${e.message}` }]);
    } finally {
      setBusy(false);
    }
  };

  const dismissPending = () => {
    setPending(null);
    setMessages((m) => [...m, { role: "tool", text: "Proposed changes discarded — the report was not modified." }]);
  };

  return (
    <aside className="chat">
      <h3>Reviewer chat</h3>
      <div className="chatlog" ref={logRef}>
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role}`}>
            {m.text}
          </div>
        ))}
        {busy && <div className="msg tool">…</div>}
        {pending && (
          <div className="msg tool pendingbox">
            <strong>Proposed changes — confirm to apply:</strong>
            <ul>
              {pending.map((a, i) => (
                <li key={i}>{a.description}</li>
              ))}
            </ul>
            <div>
              <button className="primary" onClick={confirmPending} disabled={busy}>
                Apply changes
              </button>
              <button onClick={dismissPending} disabled={busy}>
                Discard
              </button>
            </div>
          </div>
        )}
      </div>
      <div className="chatinput">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Type a command or question…"
          rows={2}
        />
        <button className="primary" onClick={send} disabled={busy}>
          Send
        </button>
      </div>
    </aside>
  );
}

// ---------------- App shell ----------------
export default function App() {
  const [view, setView] = useState({ name: "dashboard" });
  const [health, setHealth] = useState(null);
  useEffect(() => {
    api("/api/health").then(setHealth).catch(() => setHealth({ ok: false }));
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <h1>
          Pre-Approval <span>Website-Verification Tool</span>
        </h1>
        <div className="hint">
          assists the reviewer · final approve/deny stays with staff
          {health && !health.hasKey && <span className="error"> · GEMINI_API_KEY missing (see .env.example)</span>}
        </div>
      </header>
      {view.name === "dashboard" && (
        <Dashboard
          onOpenReport={(id) => setView({ name: "report", reportId: id })}
          onRunStarted={(jobId) => setView({ name: "job", jobId })}
        />
      )}
      {view.name === "job" && (
        <JobView
          jobId={view.jobId}
          onDone={(reportId) => setView({ name: "report", reportId })}
          onCancelView={() => setView({ name: "dashboard" })}
        />
      )}
      {view.name === "report" && (
        <ReportView
          reportId={view.reportId}
          onBack={() => setView({ name: "dashboard" })}
          onRunStarted={(jobId) => setView({ name: "job", jobId })}
        />
      )}
    </div>
  );
}
