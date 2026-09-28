import { apiError } from "@/lib/auth";
import { database } from "@/lib/db";
import { docketMatch, docketProjection, parseDocketQuery } from "@/lib/docket";

export const runtime = "nodejs";

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const parsed = parseDocketQuery(url);
    const db = await database();
    const mandates = await db.collection("mandates").find(parsed.query, { projection: docketProjection() }).sort({ createdAt: -1 }).limit(parsed.limit + 1).toArray();
    const hasMore = mandates.length > parsed.limit;
    const page = (hasMore ? mandates.slice(0, parsed.limit) : mandates).map((mandate) => ({ ...mandate, match: docketMatch(mandate as Record<string, any>, url) }));
    const last = page.at(-1) as Record<string, any> | undefined;
    return Response.json({ mandates: page, count: page.length, nextCursor: hasMore && last?.createdAt ? new Date(last.createdAt).toISOString() : null });
  } catch (error) {
    return apiError(error);
  }
}
