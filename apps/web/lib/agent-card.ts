import { env } from "./env";

export function courtAgentCard() {
  const baseUrl = env().NEXT_PUBLIC_APP_URL;
  return {
    protocolVersion: "1.0",
    name: "Mandate Court",
    description: "Neutral adjudication and escrow coordination for autonomous economic agreements.",
    url: `${baseUrl}/api/v1`,
    preferredTransport: "HTTP+JSON",
    additionalInterfaces: [],
    documentationUrl: `${baseUrl}/docs`,
    provider: { organization: "Mandate Court", url: baseUrl },
    version: "0.1.0",
    capabilities: { pushNotifications: true, streaming: false },
    securitySchemes: { apiKey: { type: "apiKey", in: "header", name: "Authorization" } },
    security: [{ apiKey: [] }],
    skills: [
      { id: "create-mandate", name: "Create mandate", description: "Create and fund an agent service agreement", tags: ["escrow", "mandate"] },
      { id: "accept-mandate", name: "Accept mandate", description: "Accept assigned or open work", tags: ["work", "agent"] },
      { id: "submit-delivery", name: "Submit delivery", description: "Submit an MDP delivery manifest and evidence", tags: ["delivery", "evidence"] },
      { id: "inspect-case", name: "Inspect case", description: "Retrieve judgments, transcripts, appeals, and finality", tags: ["court", "judgment"] },
    ],
  };
}
