// Two real processes interleave at the first unlocked boundary after config removal.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { setup } from "../../dist/commands.js";
import { style } from "../../dist/report.js";
import { loadState, saveState } from "../../dist/state.js";
import { readEntry, targets } from "../../dist/agents.js";

const child = process.argv[2] === "enable";
const home = child ? process.argv[3] : fs.mkdtempSync(join(tmpdir(), "cli-process-race-"));
const opts = { home, env: { TOOLSTILE_CONFIG_DIR: join(home, "cfg") }, platform: "linux" };
const remotePath = join(home, "remote.json");
const remote = () => JSON.parse(fs.readFileSync(remotePath, "utf8"));
const api = {
  account: async () => ({ email: "fixture@example.invalid", expiresAt: "2099-01-01", workspaces: [{ id: "w", slug: "fixture", name: "Fixture", personal: true }] }),
  device: async () => ({ id: "device", label: "Fixture" }),
  agents: async () => ({ agents: remote().map(id => ({ id, label: "Cursor" })) }),
  addAgent: async () => { fs.writeFileSync(remotePath, JSON.stringify([...remote(), "fresh"])); return { id: "fresh", token: "fixture-fresh", label: "Cursor" }; },
  removeAgent: async (_token, _workspace, id) => { fs.writeFileSync(remotePath, JSON.stringify(remote().filter(value => value !== id))); },
};
const ctx = { ...opts, version: "0.4.0", api: () => api, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), style: style(false) };
ctx.stdout.resume(); ctx.stderr.resume();
const cursor = targets(opts).find(target => target.client === "cursor");
if (child) {
  console.log(JSON.stringify({ code: await setup(ctx, { enable: "cursor" }) }));
} else {
  const originalRemove = fs.rmSync;
  try {
    fs.writeFileSync(remotePath, JSON.stringify(["old"]));
    const state = loadState(opts);
    state.session = { token: "fixture", email: "fixture@example.invalid", expiresAt: "2099-01-01", server: state.server };
    state.workspace = { id: "w", slug: "fixture", name: "Fixture" };
    state.device = { id: "device", label: "Fixture" };
    state.agents.cursor = { id: "old", workspaceId: "w", server: state.server, endpoint: state.server + "/mcp", label: "Cursor", token: "fixture-old" };
    saveState(state, opts);
    await setup(ctx, { enable: "cursor" });
    let enabling;
    let armed = true;
    fs.rmSync = function(path, ...args) {
      const result = originalRemove.call(this, path, ...args);
      if (armed && String(path).endsWith("/credentials.json.toolstile-lock") && !readEntry(cursor)) {
        armed = false;
        enabling = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), "enable", home], { encoding: "utf8", timeout: 5000 }));
      }
      return result;
    };
    syncBuiltinESMExports();
    const disabling = await setup(ctx, { disable: "cursor" });
    console.log(JSON.stringify({ enabling, disabling, credential: loadState(opts).agents.cursor?.id, configured: !!readEntry(cursor), remote: remote() }));
  } finally {
    fs.rmSync = originalRemove; syncBuiltinESMExports();
    fs.rmSync(home, { recursive: true, force: true });
  }
}
