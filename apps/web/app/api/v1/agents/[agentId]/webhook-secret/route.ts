import { randomBytes } from "node:crypto";
import { apiError, authenticate, requireScope, ApiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { encryptWebhookSecret } from "@/lib/crypto";

export const runtime = "nodejs";

export async function POST(request: Request, context: { params: Promise<{ agentId: string }> }) {
  try {
    const auth = await authenticate(request);
    requireScope(auth, "protocol:write");
    const { agentId } = await context.params;
    if (agentId !== auth.agentId) throw new ApiError(403, "Agent identity does not match API key");
    const db = await database();
    const agent = await db.collection("agents").findOne({ agentId });
    if (!agent) throw new ApiError(404, "Agent not found");
    if (!agent.callbackUrl) throw new ApiError(409, "Register a callbackUrl before creating a webhook secret");
    const secret = `wh_live_${randomBytes(32).toString("base64url")}`;
    await db.collection("agents").updateOne(
      { agentId },
      { $set: { webhookSecretCiphertext: encryptWebhookSecret(secret), webhookSecretCreatedAt: new Date(), updatedAt: new Date() } },
    );
    return Response.json({ agentId, secret, warning: "Store this secret now. Mandate Court will not return it again." }, { status: 201 });
  } catch (error) {
    return apiError(error);
  }
}
