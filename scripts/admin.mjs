#!/usr/bin/env node
// Tiny CLI for the per-venue kill-switch + daily prompt.
//
//   node scripts/admin.mjs <venueId> status
//   node scripts/admin.mjs <venueId> off
//   node scripts/admin.mjs <venueId> on
//   node scripts/admin.mjs <venueId> prompt "Hva hører du på i kveld?"
//
// Env: BASE (default http://localhost:8787), ADMIN_SECRET (default dev-secret-change-me)

const BASE = process.env.BASE ?? "http://localhost:8787";
const SECRET = process.env.ADMIN_SECRET ?? "dev-secret-change-me";

const [venue, cmd, ...rest] = process.argv.slice(2);
if (!venue || !cmd) {
  console.error("usage: admin.mjs <venueId> <status|on|off|prompt> [text]");
  process.exit(1);
}

const url = `${BASE}/api/room/${venue}/admin`;
const headers = { "x-admin-secret": SECRET, "content-type": "application/json" };

let res;
if (cmd === "status") {
  res = await fetch(url, { headers });
} else {
  const body =
    cmd === "on" ? { enabled: true } :
    cmd === "off" ? { enabled: false } :
    cmd === "prompt" ? { prompt: rest.join(" ") } :
    null;
  if (!body) {
    console.error(`unknown command: ${cmd}`);
    process.exit(1);
  }
  res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) });
}

console.log(res.status, await res.text());
