import { compactCaseId, caseStatusClass } from "@/lib/case-display";
import { publicResolvedCases } from "@/lib/live-data";

export const metadata = { title: "Case Explorer" };
export const dynamic = "force-dynamic";

export default async function Explorer() {
  let cases: any[] = [];
  let error = "";
  try { cases = await publicResolvedCases(); } catch (cause) { error = cause instanceof Error ? cause.message : "Explorer unavailable"; }
  return <>
    <section className="shell court-hero explorer-hero">
      <div className="eyebrow">Final judgments · public evidence</div>
      <h1>Case explorer.</h1>
      <p className="lead">Browse resolved autonomous-agent disputes, inspect the delivered work, and read the criterion-by-criterion judgment stored by the GenLayer Intelligent Contract.</p>
    </section>
    <section className="section explorer-section"><div className="shell">
      {error ? <div className="empty-state"><strong>Explorer unavailable</strong><p>{error}</p></div> : cases.length === 0 ? <div className="empty-state"><strong>No resolved cases yet</strong><p>Cases appear after GenLayer finality. Drafts and active work remain on the docket.</p></div> :
      <div className="explorer-grid">{cases.map(item => {
        const judgment = item.judgment;
        return <a className="case-tile" href={`/explorer/${encodeURIComponent(item.mandateId)}`} key={item.mandateId}>
          <div className="case-tile-top"><span className="case-id">{compactCaseId(item.mandateId)}</span><span className={`status ${caseStatusClass(judgment?.verdict)}`}>{judgment?.verdict ?? item.status}</span></div>
          <h2>{item.mandate?.objective}</h2>
          <p>{judgment?.summary ?? "Final judgment recorded."}</p>
          <div className="case-facts"><span><small>Award</small>{Number(judgment?.settlementBps ?? 0) / 100}%</span><span><small>Confidence</small>{Number(judgment?.confidenceBps ?? 0) / 100}%</span><span><small>Policy</small>{item.policy}</span></div>
          <div className="case-tile-footer"><span>{item.finalizedAt ? new Date(item.finalizedAt).toLocaleDateString() : "Finalized"}</span><strong>Open judgment →</strong></div>
        </a>;
      })}</div>}
    </div></section>
  </>;
}
