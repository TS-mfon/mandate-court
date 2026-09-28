#!/usr/bin/env node
import { configFromEnv, DEFAULT_BASE_URL, SERVER_VERSION } from "./config.js";
import { createSession, handleRequest, type JsonRpcRequest } from "./server.js";

/**
 * MCP stdio transport. Newline-delimited JSON-RPC in on stdin, newline-delimited
 * JSON-RPC out on stdout.
 *
 * Nothing but protocol messages may reach stdout, so all diagnostics go to stderr.
 * Requests are handled concurrently — a `wait_for_operation` can block for minutes and
 * must not stall the rest of the session — while writes are serialised through a queue
 * so two large responses cannot interleave on the pipe.
 */

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`${SERVER_VERSION}\n`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stderr.write(`mandate-court-mcp ${SERVER_VERSION}

Model Context Protocol server for Mandate Court, speaking JSON-RPC over stdio.
Intended to be launched by an MCP client, not run interactively.

Environment:
  MANDATE_COURT_URL         Court base URL. Defaults to ${DEFAULT_BASE_URL}
  MANDATE_COURT_API_KEY     API key for authenticated reads and all writes
  AGENT_PRIVATE_KEY         Signing wallet. Required for writes. Never transmitted.
  MANDATE_COURT_SKILLS_DIR  Override the directory the protocol skills load from

Client configuration:
  {"mcpServers":{"mandate-court":{"command":"mandate-court-mcp","env":{...}}}}
`);
  process.exit(0);
}

const config = configFromEnv();
const session = createSession(config);

let writeChain: Promise<void> = Promise.resolve();

function write(message: unknown) {
  writeChain = writeChain.then(
    () =>
      new Promise<void>((resolve) => {
        process.stdout.write(`${JSON.stringify(message)}\n`, () => resolve());
      }),
  );
  return writeChain;
}

async function dispatch(line: string) {
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(line) as JsonRpcRequest;
  } catch (error) {
    await write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error instanceof Error ? error.message : String(error)}` } });
    return;
  }
  try {
    const response = await handleRequest(request, session);
    if (response) await write(response);
  } catch (error) {
    process.stderr.write(`mandate-court-mcp: unhandled dispatch failure: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    if (request.id !== undefined && request.id !== null) {
      await write({ jsonrpc: "2.0", id: request.id, error: { code: -32603, message: error instanceof Error ? error.message : String(error) } });
    }
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
  buffer += chunk;
  for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) void dispatch(line);
  }
});
process.stdin.on("end", () => {
  const line = buffer.trim();
  buffer = "";
  if (line) void dispatch(line);
});

process.on("uncaughtException", (error) => {
  process.stderr.write(`mandate-court-mcp: uncaught exception: ${error.stack ?? error.message}\n`);
});
process.on("unhandledRejection", (reason) => {
  process.stderr.write(`mandate-court-mcp: unhandled rejection: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}\n`);
});

process.stderr.write(`mandate-court-mcp ${SERVER_VERSION} ready against ${config.baseUrl}\n`);
