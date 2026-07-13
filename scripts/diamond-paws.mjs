#!/usr/bin/env node
// Diamond Paws indexer — walks every $MOONCAT Transfer log and keeps only
// wallets that have NEVER sent a single token out. One outbound transfer,
// off the list forever. Writes holders.json for the website leaderboard.
//
//   node scripts/diamond-paws.mjs
//
// No dependencies — plain JSON-RPC against the public Robinhood Chain node.

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const TOKEN = "0x4BC437B2dB77b6fa9D9Fe54473D5eAd9f194C631";
const CREATION_BLOCK = 7439088;
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const OUT = new URL("../holders.json", import.meta.url).pathname;

const EXCLUDE = new Set([
  "0x0000000000000000000000000000000000000000",
  "0x000000000000000000000000000000000000dead",
  TOKEN.toLowerCase(),
]);

let rpcId = 0;
async function rpc(calls) {
  // accepts one {method,params} or an array; retries transient failures
  const batch = Array.isArray(calls);
  const body = (batch ? calls : [calls]).map((c) => ({ jsonrpc: "2.0", id: ++rpcId, ...c }));
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(batch ? body : body[0]),
      });
      const json = await res.json();
      const arr = batch ? json : [json];
      const err = arr.find((r) => r.error);
      if (err) throw new Error(err.error.message);
      const byId = new Map(arr.map((r) => [r.id, r.result]));
      const out = body.map((b) => byId.get(b.id));
      return batch ? out : out[0];
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 1500 * attempt));
    }
  }
}

async function getLogs(from, to) {
  // full range works today; halve on failure so this survives chain growth
  try {
    return await rpc({
      method: "eth_getLogs",
      params: [{ address: TOKEN, topics: [TRANSFER_TOPIC], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }],
    });
  } catch (e) {
    if (to - from < 2) throw e;
    const mid = Math.floor((from + to) / 2);
    return [...(await getLogs(from, mid)), ...(await getLogs(mid + 1, to))];
  }
}

const addr = (topic) => "0x" + topic.slice(26);

const latest = parseInt(await rpc({ method: "eth_blockNumber", params: [] }), 16);
const logs = await getLogs(CREATION_BLOCK, latest);
console.log(`scanned blocks ${CREATION_BLOCK}..${latest} — ${logs.length} transfers`);

// tally per-wallet flows
const w = new Map(); // addr -> {bal, out, firstBlock}
const get = (a) => w.get(a) ?? w.set(a, { bal: 0n, out: 0, firstBlock: 0 }).get(a);
for (const log of logs) {
  const from = addr(log.topics[1]), to = addr(log.topics[2]);
  const val = BigInt(log.data), bn = parseInt(log.blockNumber, 16);
  if (from !== "0x" + "0".repeat(40)) { const f = get(from); f.bal -= val; f.out++; }
  const t = get(to);
  t.bal += val;
  if (!t.firstBlock) t.firstBlock = bn;
}

// diamond rule: tokens in, never out — and a live balance
let candidates = [...w.entries()]
  .map(([address, s]) => ({ address, ...s }))
  .filter((h) => !EXCLUDE.has(h.address) && h.out === 0 && h.bal > 0n);

// drop contracts (pool manager, routers, lockers) — EOAs only
const codes = await rpc(candidates.map((h) => ({ method: "eth_getCode", params: [h.address, "latest"] })));
candidates = candidates.filter((_, i) => codes[i] === "0x");

// drop launchpad escrow / treasury-scale wallets: >=5% of supply is
// infrastructure, not a community holder (e.g. the Bags 650M allocation)
const CAP = 1_000_000_000n * 10n ** 18n / 20n;
const whales = candidates.filter((h) => h.bal >= CAP).length;
candidates = candidates.filter((h) => h.bal < CAP);

// first-buy timestamps (unique blocks only)
const blocks = [...new Set(candidates.map((h) => h.firstBlock))];
const stamps = await rpc(blocks.map((b) => ({ method: "eth_getBlockByNumber", params: ["0x" + b.toString(16), false] })));
const ts = new Map(blocks.map((b, i) => [b, parseInt(stamps[i].timestamp, 16)]));

candidates.sort((a, b) => (b.bal > a.bal ? 1 : b.bal < a.bal ? -1 : 0));
const holders = candidates.map((h) => ({
  address: h.address,
  balance: (h.bal / 10n ** 18n).toString(),
  since: ts.get(h.firstBlock),
}));

const totalHolders = [...w.values()].filter((s) => s.bal > 0n).length;
const json = {
  generatedAt: Math.floor(Date.now() / 1000),
  block: latest,
  totalHolders,
  diamondPaws: holders.length,
  excludedInfra: whales,
  holders,
};
const { writeFileSync } = await import("node:fs");
writeFileSync(OUT, JSON.stringify(json, null, 1) + "\n");
console.log(`${holders.length} diamond paws of ${totalHolders} holders -> holders.json`);
