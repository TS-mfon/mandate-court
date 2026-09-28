import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type Skill = {
  name: string;
  description: string;
  path: string;
  text: string;
};

/**
 * Candidate locations for the `skills/` directory, in priority order: an explicit
 * override, then every `skills` directory from this module upward. That resolves the
 * repository root when running from the workspace (`packages/mcp-server/{src,dist}`)
 * and the package root when installed from a registry.
 */
function candidateDirectories(explicit?: string): string[] {
  const candidates: string[] = [];
  if (explicit) candidates.push(resolve(explicit));
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    candidates.push(join(directory, "skills"));
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return candidates;
}

function parseFrontmatter(source: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(source);
  if (!match) return { fields: {} as Record<string, string>, body: source };
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, "");
    if (key) fields[key] = value;
  }
  return { fields, body: source.slice(match[0].length) };
}

function readSkillDirectory(directory: string): Skill[] {
  const skills: Skill[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "SKILL.md");
    let source: string;
    try {
      source = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const { fields, body } = parseFrontmatter(source);
    skills.push({
      name: fields.name || entry.name,
      description: fields.description || `Mandate Court skill: ${entry.name}`,
      path,
      text: body.trim() || source.trim(),
    });
  }
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

let cache: { directory?: string; skills: Skill[] } | undefined;

/**
 * Loads the protocol skills once per process. A missing directory is not fatal: the
 * server still serves every tool, and `prompts/list` simply reports nothing.
 */
export function loadSkills(explicit?: string): { directory?: string; skills: Skill[] } {
  if (cache) return cache;
  for (const directory of candidateDirectories(explicit)) {
    try {
      if (!statSync(directory).isDirectory()) continue;
    } catch {
      continue;
    }
    const skills = readSkillDirectory(directory);
    if (skills.length) {
      cache = { directory, skills };
      return cache;
    }
  }
  cache = { skills: [] };
  return cache;
}

export function resetSkillCache() {
  cache = undefined;
}
