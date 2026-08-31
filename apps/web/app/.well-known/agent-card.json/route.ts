import { courtAgentCard } from "@/lib/agent-card";

export async function GET() {
  return Response.json(courtAgentCard());
}
