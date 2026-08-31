import { fixtures } from "@/lib/fixtures";

export async function GET(_: Request, context: { params: Promise<{ fixtureId: string }> }) {
  const { fixtureId } = await context.params;
  const fixture = fixtures.find((item) => item.id === Number(fixtureId));
  if (!fixture) return Response.json({ error: "Fixture not found" }, { status: 404 });
  return Response.json({ protocol: "mdp-fixture/1.0", generatedAt: "2026-08-28T00:00:00.000Z", ...fixture });
}
