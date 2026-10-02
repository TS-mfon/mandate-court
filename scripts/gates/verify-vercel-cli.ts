// G1 oracle. Proves the Vercel CLI is a pinned project dependency driven through
// package scripts, rather than fetched by npx at run time.
//
// `npx vercel@latest` silently changes version between invocations and needs the
// network on every call, so a deploy that worked yesterday can behave
// differently today. The gate requires a pinned version in devDependencies, a
// matching local binary, package scripts that invoke it, and a working
// authenticated call against this project.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const REPO = "/home/sudodave/mandate-court";

function run(file: string, args: string[]) {
  return execFileSync(file, args, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120_000 }).trim();
}

// Only files git tracks count: the claim is about what the repository tells a
// reader to run. Ignored machine-local files, such as a Claude Code permission
// allowlist that recorded an earlier npx invocation, are not instructions.
function trackedTextFiles() {
  return run("git", ["ls-files"])
    .split("\n")
    .filter((p) => /\.(ts|tsx|mjs|js|json|ya?ml|md)$/.test(p))
    .filter((p) => existsSync(join(REPO, p)));
}

async function main() {
  const failures: string[] = [];
  const pkg = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    devDependencies?: Record<string, string>;
    scripts?: Record<string, string>;
  };

  // 1. Pinned, exact version in devDependencies.
  const declared = pkg.devDependencies?.vercel;
  const pinned = Boolean(declared && /^\d+\.\d+\.\d+$/.test(declared));
  console.log(`devDependencies.vercel      ${declared ?? "ABSENT"} ${pinned ? "(exact pin)" : "(NOT an exact pin)"}`);
  if (!declared) failures.push("vercel is not in devDependencies");
  else if (!pinned) failures.push(`vercel is declared as "${declared}", which is a range rather than an exact pin`);

  // 2. The local binary exists and reports that exact version.
  const bin = join(REPO, "node_modules/.bin/vercel");
  const installed = existsSync(bin);
  console.log(`node_modules/.bin/vercel    ${installed ? "present" : "ABSENT"}`);
  if (!installed) failures.push("the vercel binary is not installed locally");
  else {
    const version = run(bin, ["--version"]).split("\n").pop()!.trim();
    const matches = version === declared;
    console.log(`binary reports              ${version} ${matches ? "(matches the pin)" : `(DOES NOT match ${declared})`}`);
    if (!matches) failures.push(`the installed binary reports ${version} but package.json pins ${declared}`);
  }

  // 3. Package scripts drive it, and none of them fetch it with npx.
  console.log();
  const scripts = pkg.scripts ?? {};
  const driving = Object.entries(scripts).filter(([, cmd]) => /(^|[\s&|])vercel(\s|$)/.test(cmd));
  console.log(`scripts invoking vercel     ${driving.length ? driving.map(([k]) => k).join(", ") : "NONE"}`);
  if (!driving.length) failures.push("no package script invokes the vercel CLI");
  for (const name of ["deploy", "env:audit"]) {
    if (!scripts[name]) failures.push(`package script "${name}" is missing`);
  }
  const npxScripts = Object.entries(scripts).filter(([, cmd]) => /npx\s+(--yes\s+)?vercel/.test(cmd));
  if (npxScripts.length) {
    console.log(`scripts still using npx     ${npxScripts.map(([k]) => k).join(", ")}`);
    failures.push(`${npxScripts.length} package script(s) still fetch vercel through npx`);
  } else {
    console.log("scripts still using npx     none");
  }

  // 4. No file git tracks tells a reader to run npx vercel@latest.
  const offenders: string[] = [];
  for (const file of trackedTextFiles()) {
    if (file.endsWith("GATES.md") || file.startsWith("scripts/gates/")) continue;
    const text = readFileSync(join(REPO, file), "utf8");
    if (/npx\s+(--yes\s+)?vercel@/.test(text)) offenders.push(file);
  }
  console.log(`tracked files using npx     ${offenders.length ? offenders.join(", ") : "none"}`);
  if (offenders.length) failures.push(`${offenders.length} tracked file(s) still instruct using npx vercel@<version>`);

  // 5. The CLI authenticates and resolves this project, so the pin is usable.
  console.log();
  let who = "";
  try {
    who = run(bin, ["whoami"]).split("\n").pop()!.trim();
  } catch (error) {
    failures.push(`vercel whoami failed: ${String(error).split("\n")[0].slice(0, 140)}`);
  }
  console.log(`vercel whoami               ${who || "FAILED"}`);

  const project = JSON.parse(readFileSync(join(REPO, ".vercel/project.json"), "utf8")) as { projectName: string; projectId: string };
  console.log(`linked project              ${project.projectName} (${project.projectId})`);
  if (!project.projectId) failures.push(".vercel/project.json has no projectId");

  console.log();
  if (failures.length) {
    for (const f of failures) console.log(`FAIL: ${f}`);
    console.log(`\n${failures.length} failure(s)`);
    process.exit(1);
  }
  console.log("GATE G1 PASS");
}

main().catch((error) => {
  console.error(String(error instanceof Error ? error.message : error));
  process.exit(1);
});
