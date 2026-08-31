import { notFound } from "next/navigation";
import { compactCaseId, caseStatusClass } from "@/lib/case-display";
import { readGenLayerCase } from "@/lib/genlayer";
import { publicResolvedCase } from "@/lib/live-data";

export const dynamic = "force-dynamic";

export default async function ExplorerCase({ params }: { params: Promise<{ caseId: string }> }) {
  const { caseId } = await params;
  const item = await publicResolvedCase(caseId);
  if (!item) notFound();
  let contractCase: Record<string, any> | undefined;
  let contractError = "";
  try { contractCase = await readGenLayerCase(item.mandateId); } catch (cause) { contractError = cause instanceof Error ? cause.message : "GenLayer read unavailable"; }
  const judgment = contractCase?.judgment ?? item.judgment;
  const judgmentSource = contractCase?.judgment ? "Live GenLayer contract read" : "Finalized indexed contract record";
  const artifacts = item.manifest?.artifacts ?? [];
  const evidence = item.manifest?.evidence ?? [];
  return <>
    <section className="shell court-hero case-detail-hero">
      <div className="case-heading-row"><div><div className="eyebrow">Public judgment</div><span className="display-case-id">{compactCaseId(item.mandateId)}</span></div><span className={`status verdict-status ${caseStatusClass(judgment?.verdict)}`}>{judgment?.verdict ?? "FINALIZED"}</span></div>
      <h1>{item.mandate?.objective}</h1>
      <p className="lead">{judgment?.summary}</p>
      <div className="source-banner"><span className={contractCase ? "source-dot live" : "source-dot"}/><strong>{judgmentSource}</strong><span>{contractError ? "StudioNet was unavailable; showing the immutable finalized copy." : `Contract ${process.env.GENLAYER_CONTRACT_ADDRESS}`}</span></div>
    </section>
    <section className="section compact-section"><div className="shell grid-3">
      <div className="panel"><span className="number">SETTLEMENT</span><div className="metric panel-metric">{Number(judgment?.settlementBps ?? 0) / 100}%</div><p>{item.status === "SETTLED" ? "Base escrow settlement confirmed." : "Finalized judgment awaiting Base settlement."}</p></div>
      <div className="panel"><span className="number">CONFIDENCE</span><div className="metric panel-metric">{Number(judgment?.confidenceBps ?? 0) / 100}%</div><p>Reported by the finalized GenLayer judgment.</p></div>
      <div className="panel"><span className="number">DELIVERY</span><div className="metric panel-metric">{artifacts.length}</div><p>Public artifacts committed by exact SHA-256 digest.</p></div>
    </div></section>
    <section className="section"><div className="shell case-layout">
      <article>
        <div className="section-head"><div><div className="eyebrow">GenLayer reasoning</div><h2>Criterion findings.</h2></div></div>
        <div className="finding-list">{(judgment?.criteria ?? []).map((criterion: any) => <div className="finding" key={criterion.id}>
          <div className="finding-head"><span className="criterion-id">{criterion.id}</span><span className={`result result-${String(criterion.result).toLowerCase()}`}>{criterion.result}</span><span className="severity">{criterion.severity}</span><strong>{Number(criterion.weightBps) / 100}% weight</strong></div>
          <p>{criterion.reason}</p>
          <div className="finding-meta"><span>{criterion.reasonCode}</span><span>Evidence: {(criterion.evidenceRefs ?? []).join(", ") || "None"}</span></div>
        </div>)}</div>
        <div className="section-head transcript-head"><div><div className="eyebrow">Evidence rulings</div><h2>Admissibility.</h2></div></div>
        <div className="evidence-rulings">{(judgment?.admissibility ?? []).map((ruling: any) => <div className="ruling" key={ruling.id}><strong>{ruling.id}</strong><span className={`result result-${String(ruling.status).toLowerCase()}`}>{ruling.status}</span><p>{ruling.reason}</p></div>)}</div>
        {[["Contradictions", judgment?.contradictions], ["Material breaches", judgment?.materialBreaches], ["Missing evidence", judgment?.missingEvidence], ["Potential appeal grounds", judgment?.appealGrounds]].map(([title, values]: any) => values?.length ? <div className="judgment-notes" key={title}><h3>{title}</h3><ul>{values.map((value: string) => <li key={value}>{value}</li>)}</ul></div> : null)}
      </article>
      <aside className="case-sidebar">
        <div className="record-card"><span className="number">CASE RECORD</span><dl><dt>Full case ID</dt><dd className="mono-small">{item.mandateId}</dd><dt>GenLayer transaction</dt><dd className="mono-small">{item.genlayerTransactionId}</dd><dt>Judgment hash</dt><dd className="mono-small">{contractCase?.judgment_hash ?? item.judgmentHash}</dd><dt>Delivery hash</dt><dd className="mono-small">{contractCase?.delivery_hash ?? item.deliveryHash}</dd><dt>Policy</dt><dd>{contractCase?.policy ?? item.policy}</dd><dt>Base status</dt><dd>{item.onchain?.status ?? item.status}</dd></dl></div>
        <div className="record-card"><span className="number">DELIVERED WORK</span><div className="artifact-list">{artifacts.map((artifact: any) => <a href={artifact.url} target="_blank" rel="noreferrer" key={artifact.id}><strong>{artifact.id} · {artifact.type}</strong><span>{artifact.mediaType}</span><small className="mono-small">{artifact.sha256}</small></a>)}</div></div>
        <div className="record-card"><span className="number">SUPPORTING EVIDENCE</span><div className="artifact-list">{evidence.map((entry: any) => <a href={entry.url} target="_blank" rel="noreferrer" key={entry.id}><strong>{entry.id} · {entry.type}</strong><span>Supports {(entry.supports ?? []).join(", ")}</span></a>)}</div></div>
      </aside>
    </div></section>
  </>;
}
