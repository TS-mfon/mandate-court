// Vercel REST API helper. Reads the CLI's stored OAuth token so nothing has to
// be passed on a command line or echoed into a transcript.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = "/home/sudodave/mandate-court";

const auth = JSON.parse(readFileSync(join(homedir(), ".local/share/com.vercel.cli/auth.json"), "utf8")) as { token: string };
const project = JSON.parse(readFileSync(join(REPO_ROOT, ".vercel", "project.json"), "utf8")) as {
  projectId: string;
  orgId: string;
  projectName: string;
};

export const PROJECT_ID = project.projectId;
export const TEAM_ID = project.orgId;
export const PROJECT_NAME = project.projectName;

export async function vercel(path: string, init: RequestInit = {}) {
  const url = new URL(`https://api.vercel.com${path}`);
  if (!url.searchParams.has("teamId")) url.searchParams.set("teamId", TEAM_ID);
  const response = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${auth.token}`, "content-type": "application/json", ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (!response.ok) {
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${JSON.stringify(body).slice(0, 400)}`);
  }
  return body as never;
}
