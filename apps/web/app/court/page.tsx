import { liveMandates } from "@/lib/live-data";
export const metadata = { title: "Court Record" };
export const dynamic = "force-dynamic";
export default async function Court({searchParams}:{searchParams:Promise<{case?:string}>}){
  const {case:caseId}=await searchParams; let cases:any[]=[]; let error="";
  try { cases=await liveMandates(100,caseId?{mandateId:caseId}:{}); } catch(cause){error=cause instanceof Error?cause.message:"Court record unavailable";}
  const item=cases[0];
  if(error||!item)return <section className="shell court-hero"><div className="eyebrow">Public court record</div><h1>{error?"Court unavailable.":"No cases yet."}</h1><div className="empty-state"><p>{error||"A court record will appear after a provider submits evidence."}</p></div></section>;
  const judgment=item.judgment; const events=[
    [item.createdAt,"Mandate prepared",`${Number(item.mandate?.payment?.amountAtomic??0)/1_000_000} USDC mandate indexed.`],
    [item.baseTransactionHash?item.updatedAt:null,"Base transaction",item.baseTransactionHash??"Awaiting Base confirmation."],
    [item.manifest?.submittedAt,"Delivery submitted",item.manifest?.summary],
    [item.finalizedAt,"Final judgment",judgment?.summary],
  ].filter(event=>event[0]||event[2]);
  return <><section className="shell court-hero"><div className="eyebrow">Public court record · {item.mandateId}</div><h1>{item.mandate?.objective}</h1><p className="lead">Status: {item.onchain?.status??item.status}. This page reflects the live indexed case and canonical Base read when available.</p></section><section className="section"><div className="shell grid-3"><div className="panel"><span className="number">VERDICT</span><h3>{judgment?.verdict??"Pending"}</h3><p>{judgment?.summary??"The Court has not finalized a judgment."}</p></div><div className="panel"><span className="number">SETTLEMENT</span><div className="metric" style={{marginTop:28}}>{judgment?`${Number(judgment.settlementBps)/100}%`:"—"}</div><p>{item.status==="SETTLED"?"Base settlement confirmed.":"No settlement before finality."}</p></div><div className="panel"><span className="number">CONFIDENCE</span><div className="metric" style={{marginTop:28}}>{judgment?`${Number(judgment.confidenceBps)/100}%`:"—"}</div><p>Derived from the finalized GenLayer judgment.</p></div></div></section><section className="section"><div className="shell"><div className="section-head"><div><div className="eyebrow">Machine-readable transcript</div><h2>Proceedings.</h2></div></div><div className="timeline">{events.map((event,index)=><div className="timeline-item" key={`${event[1]}-${index}`}><span className="time">{event[0]?new Date(String(event[0])).toLocaleString():"Pending"}</span><span className="rail"/><div><h3>{event[1]}</h3><p style={{color:"var(--muted)",overflowWrap:"anywhere"}}>{event[2]??"—"}</p></div></div>)}</div></div></section></>;
}
