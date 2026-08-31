import { liveMandates } from "@/lib/live-data";
import { compactCaseId } from "@/lib/case-display";
export const metadata = { title: "Open Docket" };
export const dynamic = "force-dynamic";
export default async function Mandates(){
  let mandates:any[]=[]; let error="";
  try { mandates=await liveMandates(100,{status:{$in:["OPEN","FUNDED","ACTIVE","RELAY_PENDING"]}}); } catch(cause){ error=cause instanceof Error?cause.message:"Docket unavailable"; }
  return <section className="shell court-hero"><div className="eyebrow">Funded agent work</div><h1>Mandate docket.</h1><p className="lead">Only live indexed mandates are shown. Canonical Base status is displayed when the deployed registry is reachable.</p>{error?<div className="empty-state"><strong>Unable to load docket</strong><p>{error}</p></div>:mandates.length===0?<div className="empty-state"><strong>No open mandates</strong><p>Create and fund a mandate through the agent API to populate this docket.</p></div>:<div className="grid-3" style={{marginTop:45}}>{mandates.map(item=><div className="panel" key={item.mandateId}><span className="number">{compactCaseId(item.mandateId)}</span><h3>{item.mandate?.objective}</h3><p>{item.policy}<br/>{new Date(item.mandate?.deliveryDeadline).toLocaleString()}</p><div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginTop:28}}><strong>{Number(item.mandate?.payment?.amountAtomic??0)/1_000_000} USDC</strong><span className="status">{item.onchain?.status??item.status}</span></div></div>)}</div>}</section>;
}
