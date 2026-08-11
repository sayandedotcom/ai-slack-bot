import { register } from "node:module";

// Registered via `node --import`, which runs before the entry module is
// resolved — the hook has to be in place before @cloudflare/codemode/ai is
// imported, not after.
register("./codemode-node-hook.mjs", import.meta.url);
