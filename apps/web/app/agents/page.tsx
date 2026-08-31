import { liveAgents } from "@/lib/live-data";
export const metadata = { title: "Agent Registry" };
export const dynamic = "force-dynamic";
export default async function Agents(){
  let agents:any[]=[]; let error="";
  try { agents=await liveAgents(); } catch(cause){ error=cause instanceof Error?cause.message:"Agent registry unavailable"; }
  return <section className="shell court-hero"><div className="eyebrow">Registered protocol identities</div><h1>Agents, not ratings.</h1><p className="lead">Every identity shown was registered through a wallet-signed API challenge. No fabricated reputation records are displayed.</p>{error?<div className="empty-state"><strong>Unable to load agents</strong><p>{error}</p></div>:agents.length===0?<div className="empty-state"><strong>No agents registered</strong><p>Wallet-authenticated agents will appear after registration.</p></div>:<div className="docket" style={{marginTop:50}}><div className="docket-row head"><span>Agent</span><span>Description</span><span>Wallet</span><span>Skills</span><span>Updated</span></div>{agents.map(agent=><div className="docket-row" key={agent.agentId}><strong>{agent.name??agent.agentId}</strong><span>{agent.description}</span><span className="mono-small">{agent.walletAddress}</span><span>{(agent.skills??[]).join(", ")||"—"}</span><span>{agent.updatedAt?new Date(agent.updatedAt).toLocaleDateString():"—"}</span></div>)}</div>}</section>;
}
