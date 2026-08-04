# Frontier

An MCP server for building **verified historical timelines** of technical fields and tracking each field's research frontier over time.

The calling model decomposes a field, proposes historical milestone claims, and calls this server to verify each claim against real sources and to retrieve current research. The server returns structured evidence; the model does the interpreting.

**This server makes zero LLM calls.** No API key, no model client, no inference dependency. It does HTTP requests to public APIs, parsing and deduplication, SQLite caching, and deterministic scoring — nothing else. See [`CODEX_SPEC.md`](./CODEX_SPEC.md) §2.

## Status

**Phase 1 of 10 — skeleton.** The server starts, connects over stdio, and registers one no-op tool (`ping`). The full data contract is defined in `src/types.ts`. Storage, rate limiting, source adapters, and verification are not built yet; see §10 of the spec for the build order.

## Requirements

Node.js 18 or newer. No other prerequisites — no Python, no API keys, no model downloads.

## Build and test

```sh
npm install
npm run build     # tsc -> dist/
npm test          # spawns the built server and drives it with a real MCP client
```

Tests make no network calls and pass with the network disabled.

## Run

```sh
npm start         # node dist/index.js, speaking MCP over stdio
```

The server speaks JSON-RPC on stdout, so it is not meant to be used interactively — point an MCP client at it. To register it with a client directly:

```json
{
  "mcpServers": {
    "frontier": {
      "command": "node",
      "args": ["/absolute/path/to/dist/index.js"]
    }
  }
}
```

`manifest.json` is a valid [MCPB](https://github.com/anthropics/mcpb) manifest, so the repo will also build to an installable `.mcpb` bundle (Phase 10).

## Layout

```
manifest.json           MCPB manifest
src/
  index.ts              MCP server entry, tool registration
  types.ts              the data contract (spec §4)
test/
  smoke.test.js         phase 1: handshake, tool listing, tool call
  fixtures/  golden/    recorded API responses and hand-written expected answers
```

## License

MIT
