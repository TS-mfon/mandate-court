import { isAbsolute, resolve } from "node:path";

export function normalizeCliArgs(argv: string[]) {
  const separator = argv.indexOf("--");
  return separator === -1 ? argv : [...argv.slice(0, separator), ...argv.slice(separator + 1)];
}

export function resolveCliPath(path: string, initialDirectory = process.env.INIT_CWD ?? process.cwd()) {
  return isAbsolute(path) ? path : resolve(initialDirectory, path);
}
