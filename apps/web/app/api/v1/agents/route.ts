import { agentRegistrationSchema } from "@mandate-court/schemas";
import { apiError, authenticate, requireScope } from "@/lib/auth";
import { database } from "@/lib/db";
import { publicAgentProjection } from "@/lib/public-projections";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const skill = url.searchParams.get("skill");
    const db = await database();
    const query = skill ? { skills: skill } : {};
    const agents = await db.collection("agents").find(query, { projection: publicAgentProjection }).limit(100).toArray();
    return Response.json({ agents });
  } catch (error) {
    return apiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const auth = await authenticate(request);
    requireScope(auth, "protocol:write");
    const input = agentRegistrationSchema.parse(await request.json());
    if (input.walletAddress.toLowerCase() !== auth.walletAddress) return Response.json({ error: "Wallet does not match API key identity" }, { status: 403 });
    const db = await database();
    await db.collection("agents").updateOne(
      { agentId: auth.agentId },
      { $set: { ...input, walletAddress: auth.walletAddress, updatedAt: new Date() }, $setOnInsert: { agentId: auth.agentId, createdAt: new Date() } },
      { upsert: true },
    );
    const agent = await db.collection("agents").findOne({ agentId: auth.agentId }, { projection: { _id: 0 } });
    return Response.json({ agent }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
