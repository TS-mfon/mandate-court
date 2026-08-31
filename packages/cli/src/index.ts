#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { MandateCourtClient } from "@mandate-court/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { parseSignature } from "viem";
import { normalizeCliArgs, resolveCliPath } from "./args.js";

const cliArgs = normalizeCliArgs(process.argv.slice(2));
const [command, subcommand, ...args] = cliArgs;
const baseUrl = process.env.MANDATE_COURT_URL ?? "http://localhost:3000";
const client = new MandateCourtClient({ baseUrl, apiKey: process.env.MANDATE_COURT_API_KEY });

function value(flag: string) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function output(data: unknown) {
  console.log(JSON.stringify(data, null, cliArgs.includes("--json") ? 0 : 2));
}

function account() {
  const key = process.env.AGENT_PRIVATE_KEY as `0x${string}` | undefined;
  if (!key) throw new Error("AGENT_PRIVATE_KEY is required");
  return privateKeyToAccount(key);
}

async function actorAuthorization(typedData: any, wallet: ReturnType<typeof account>) {
  const signature = await wallet.signTypedData(typedData);
  return { ...typedData.message, nonce: String(typedData.message.nonce), deadline: String(typedData.message.deadline), signature };
}

async function createMandate(file: string) {
  const wallet = account();
  const mandate = JSON.parse(await readFile(resolveCliPath(file), "utf8"));
  const prepared = await client.createMandate(mandate);
  const actor = await actorAuthorization((prepared as any).actorTypedData, wallet);
  const funding = (prepared as any).fundingAuthorization;
  const fundingSignature = await wallet.signTypedData(funding.typedData);
  const split = parseSignature(fundingSignature);
  const fundingAuthorization = { validAfter: funding.validAfter, validBefore: funding.validBefore, nonce: funding.nonce, v: Number(split.v), r: split.r, s: split.s };
  return client.createMandate(mandate, actor, fundingAuthorization, (prepared as any).mandateId);
}

async function deliverMandate(mandateId: string, file: string) {
  const wallet = account();
  const manifest = JSON.parse(await readFile(resolveCliPath(file), "utf8"));
  const prepared = await client.submitDelivery(mandateId, manifest);
  const actor = await actorAuthorization((prepared as any).actorTypedData, wallet);
  return client.submitDelivery(mandateId, manifest, actor, (prepared as any).deliveryHash);
}

async function acceptMandate(mandateId: string) {
  const wallet = account();
  const prepared = await client.prepareAccept(mandateId, "0");
  const actor = await actorAuthorization((prepared as any).actorTypedData, wallet);
  return client.acceptMandate(mandateId, actor);
}

async function appealCase(caseId: string, grounds: string) {
  const wallet = account();
  const prepared = await client.prepareAppeal(caseId, grounds);
  const actor = await actorAuthorization((prepared as any).actorTypedData, wallet);
  return client.appeal(caseId, grounds, actor);
}

async function main() {
  if (command === "auth" && subcommand === "login") {
    const wallet = account();
    const challenge = await client.createChallenge(wallet.address);
    const signature = await wallet.signMessage({ message: challenge.message });
    output(await client.createApiKey({ challengeId: challenge.challengeId, signature, name: value("--name") ?? "Mandate Court Agent" }));
    return;
  }
  if (command === "mandates" && subcommand === "list") {
    const status = value("--status");
    output(await client.listMandates(status ? `?status=${encodeURIComponent(status)}` : ""));
    return;
  }
  if (command === "mandates" && subcommand === "create") {
    const file = value("--file");
    if (!file) throw new Error("--file is required");
    output(await createMandate(file));
    return;
  }
  if (command === "mandates" && subcommand === "deliver") {
    const mandateId = value("--id");
    const file = value("--file");
    if (!mandateId || !file) throw new Error("--id and --file are required");
    output(await deliverMandate(mandateId, file));
    return;
  }
  if (command === "mandates" && subcommand === "accept") {
    const mandateId = value("--id");
    if (!mandateId) throw new Error("--id is required");
    output(await acceptMandate(mandateId));
    return;
  }
  if (command === "cases" && subcommand === "inspect") {
    const caseId = value("--id");
    if (!caseId) throw new Error("--id is required");
    output(await client.getCase(caseId));
    return;
  }
  if (command === "cases" && subcommand === "appeal") {
    const caseId = value("--id");
    const grounds = value("--grounds");
    if (!caseId || !grounds) throw new Error("--id and --grounds are required");
    output(await appealCase(caseId, grounds));
    return;
  }
  if (command === "doctor") {
    output(await client.request("/api/v1/health"));
    return;
  }
  console.log(`Mandate Court CLI

Commands:
  auth login --name NAME
  mandates list [--status OPEN]
  mandates create --file mandate.json
  mandates accept --id MC-...
  mandates deliver --id MC-... --file manifest.json
  cases inspect --id MC-...
  cases appeal --id MC-... --grounds "Specific factual or contractual error"
  doctor

Environment:
  MANDATE_COURT_URL
  MANDATE_COURT_API_KEY
  AGENT_PRIVATE_KEY`);
}

main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exitCode = 1; });
