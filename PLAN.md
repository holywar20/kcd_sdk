---
type: plan
status: active
lens: lens_crafter
created: 2026-06-05
updated: 2026-06-05
revised: 2026-06-05
---

# KCD MCP Server

> A TypeScript MCP server and client-side object SDK for querying and editing KCD deployments — thin I/O gate + fat self-parsing objects.

---

## Goal

Build a minimal MCP server specialized for KCD artifact access, plus a shared TypeScript object SDK (`KCDPrimitive` and subclasses) that any client — Electron UI, AI agent — can use to load, traverse, edit, and save KCD artifacts. The MCP provides security-gated I/O; the SDK provides all semantic behavior. Dual purpose: learning how an MCP is structured, and producing a functional tool for the Electron KCD editor.

## Approach

Two repos built in sequence:

1. **`kcd_sdk`** — growing library of solved KCD problems; file scanner, `KCDPrimitive` and subclasses, dredge orchestrator, link resolution, health checking. Everything else depends on this; it depends on nothing KCD-specific. Lives at `C:\idt\kcd_sdk`, own git repo.
2. **`kcd_mcp`** — thin MCP server; 9 tools; startup index; pure JSON wire format. One consumer of `kcd_sdk`. Lives at `C:\idt\kcd_mcp`, own git repo.

The dependency direction is a hard rule: if something inside `kcd_sdk` tries to import from `kcd_mcp`, the boundary is wrong. The SDK accumulates solved problems once; every downstream consumer (MCP server, Electron app, future CLI, CI tools) imports rather than reimplements.

Cross-repo dependency: `file:../kcd_sdk` in `kcd_mcp`'s package.json. Both repos live under `C:\idt\` so the sibling relative path is stable.

The dredge runs **server-side**, inside the object. `LensObject.load(path)` reads, parses, and recursively loads the `always`-children using the object's own file reader, returning a fully-built lens. The client never dredges — it receives pure JSON across the MCP/IPC boundary and hydrates via `fromSerialized` (no disk access). To promote an unloaded stub, the client sends its href/id back to the server.

## Decisions (locked)

### Configuration

| Variable | Purpose | Example |
|---|---|---|
| `projectRoot` | Project root; used for link resolution | `C:\idt` |
| `docRoot` | Doc root relative to projectRoot; scanner root | `_Claude` (hardcoded for prototype) |

`docRoot` is hardcoded for the prototype. Making it a parameter is a one-line change; everything else is already path-agnostic.

### Directory → Type mapping (enforced, not configurable)

| Prefix (relative to docRoot) | Type |
|---|---|
| `lenses/` | `lens` |
| `plans/` | `plan` |
| `plans_complete/` | `plan` (archived) |
| `references/` | `reference` |
| `generators/` | `generator` |
| `analyzers/` | `analyzer` |
| `pipelines/` | `pipeline` |
| `habits/` | `habit` |
| `contracts/` | `contract` |
| `kcd/templates/` | `template` |
| `kcd/` | `framework` |
| anything else | `unknown` |

Directory wins over frontmatter `type:`. If they disagree, it is a `warn`-level health issue — the classifier does not bend.

### MCP wire format

Pure JSON across the MCP boundary. No object instances cross the wire. Objects serialize to JSON for `kcd_save`; `kcd_get` returns JSON; SDK hydrates objects from it. Avoids data type corruption from object serialization.

### MCP tool surface (9 tools)

**Discovery — returns lightweight refs:**

| Tool | Args | Returns |
|---|---|---|
| `kcd_glob` | `pattern: string` | `ArtifactRef[]` |
| `kcd_list` | `type: ArtifactType` | `ArtifactRef[]` |
| `kcd_search` | `query: string, scope?: string` | `SearchHit[]` |
| `kcd_types` | — | `{type, count}[]` |

**Read — returns serialized JSON for one artifact:**

| Tool | Args | Returns |
|---|---|---|
| `kcd_get` | `path: string` | `SerializedArtifact` |
| `kcd_links` | `path: string` | `{outbound, inbound}: LinkEntry[]` |
| `kcd_health` | `path?: string` | `HealthReport` |

**Write — accepts JSON; validates before touching disk:**

| Tool | Args | Returns |
|---|---|---|
| `kcd_save` | `writes: WriteMap` | `SaveResult` |
| `kcd_move` | `from: string, to: string` | `MoveResult` |

`kcd_save` accepts a `WriteMap` (`Record<path, SerializedArtifact>`) — the flat output of the SDK's dirty-object collection. One call, atomic save of the whole graph. `kcd_move` is the hardest tool; the prototype may stub it with a warning.

### Object SDK design

**Inheritance tree:**
```
KCDPrimitive
├── LensObject
├── PlanObject
├── ReferenceObject
├── ProcedureObject
├── HabitObject
├── ContractObject
├── TemplateObject
└── FrameworkObject
```

**Fat objects — parser logic lives inside the class.** No external parsers. Behavior travels with the data. Children override methods and call `super` — most logic stays in the base.

**`KCDPrimitive` protected state:**
```ts
protected path: string
protected type: ArtifactType
protected frontmatter: Record<string, any>
protected sections: Record<string, string>   // H2 name → content
protected body: string
protected links: LinkEntry[]
protected dredgeDepth: number                // default 1; hard cap DREDGE_MAX = 4
protected dredgeFilter: Set<string>          // which link hrefs are eligible for dredging
protected isDirty: boolean                   // set by any setter
```

**Static entry points:**
```ts
static from(json: SerializedArtifact): KCDPrimitive   // throws KCDParseError | KCDValidationError
static parse(markdown: string, path: string): KCDPrimitive  // same pipeline, different input
```

**Parser method chain (called by both entry points):**
```
parseFrontmatter → validateFrontmatter → parseBody → validateStructure → extractLinks
```
Any failure throws. The object is never in a partially constructed state.

**Override pattern:**
```ts
protected validateFrontmatter(): void { super.validateFrontmatter(); /* child checks */ }
protected validateStructure(): void   { /* child implements required section checks */ }
protected parseBody(body: string): void { super.parseBody(body); /* child extends */ }
toMarkdown(): string { /* child controls section order and type-specific formatting */ }
```

**Dredge: the spine orchestrates; the base is a pure artifact.**

The dredge is **not** distributed across the objects and there is **no injected context**. The spine (`LensObject`) owns its `projectRoot` and a single `readFile()` seam, and runs the whole traversal internally (`dredgeFrom(node, remaining, visited)`): it reads each child, classifies and builds it, asks it for its policy (`getPolicy()`, public), and recurses on the `always` entries. Every other artifact is a pure data object — it parses itself and exposes `getPolicy()`, nothing more. "Ask a lens object": instantiate with a path, and it assembles the graph.

`remaining` is a ceiling that decrements per level and never rises. The flat `nodes: KCDPrimitive[]` array is held only by the spine; other nodes carry no spine state. A visited set (keyed by path now, id later) breaks cycles and — critically — prevents an already-loaded node, which may carry unsaved ephemeral edits, from being clobbered by a re-dredge.

Depth: per-type default (lens 2), clamped `[1, DREDGE_MAX=4]`. `remaining == 1` loads the node but dredges no children. Only `always` links consume budget; conditional links never auto-load.

> **Design note (information hiding over composition).** An earlier draft threaded a `DredgeContext { reader, projectRoot }` param through a virtual `dredge()` on the base. That was dependency injection — the reader's identity spread across call sites, the base carrying I/O concerns. It was collapsed: the spine owns the reader and the traversal; the base knows nothing about I/O. Per-instance ownership also fits the multi-project UI (each lens has its own reader/root, no global). Variation (virtual FS, test fixtures) is achieved by **overriding `readFile()`**, not by injecting a reader.

**Policy lives in the What | Where | Why table.** For a lens, the Know-section table *is* the dredge policy. Each row parses to a `PolicyEntry { what, href, why, always, type, section }`; `always` is set when the Why cell leads with "always". Conditional rows stay unloaded — surfaced to the agent as stubs whose Why text drives the load decision. No documentation changes; the existing format already encodes the policy.

**No graph object.** The networked structure *is* the parent→child links; a separate graph would re-represent what already exists. Loaded objects live in the spine's flat `nodes` array; a "stub" is simply an unloaded policy entry on the lens. Context assembly is a spine operation: iterate `nodes` (load order for now; section-aware ordering later); each node renders its own content block via `toContextBlock()`, and the lens's unloaded policy entries trail as a What|Where|Why table. The recursion flattens to a text blob — neither AI nor user sees it.

**I/O model.** `readFile()` is the single I/O seam, a method on the spine (`LensObject`), defaulting to `defaultReader` (fs). Override it in a subclass for a virtual FS (UI) or fixtures (tests) — no injected reader. `LensObject.load(path)` reads, parses, dredges, and returns a fully-built lens — "init with a path, it works." `projectRoot` (needed to resolve vault-root-relative hrefs to disk) is inferred from the lens path by walking up to the ancestor that contains `docRoot` (`_Claude`); overridable via `opts`. Across the MCP/IPC boundary no reader is present — the client hydrates from pure JSON via `fromSerialized`. Stateless helpers (`resolveHref`, `classifyByPath`, `inferProjectRoot`, `defaultReader`) live in `io.ts` so the MCP server reuses them for the startup index.

**Write collection:**
```ts
collectWrites(objects: KCDPrimitive[]): WriteMap  // flat scan; only isDirty objects contribute
```
With `nodes` already flat on the root, save needs no recursion: filter the array on each node's own `isDirty`. No parent validates a child's dirty state.

**Error types:**
```ts
class KCDParseError extends Error {
  path: string; line?: number; rawContent: string
}
class KCDValidationError extends Error {
  path: string; field?: string; section?: string; expected: string; got: string | null
}
```

### Startup index (MCP server)

1. Scanner walks `projectRoot/docRoot` → `ScannedFile[]`
2. Classifier assigns type by directory convention → `ClassifiedFile[]`
3. Indexer builds: type map, path map, link graph (outbound + inverted inbound), index cross-check
4. Index cross-check: parse known `index.md` files; compare declared entries against path map; discrepancies → `warn` health issues
5. Index held in memory; invalidated per-file on `kcd_save` / `kcd_move`

---

## Phases

### Phase 0 — Scaffolding + File Scanner

**Purpose:** Initialize both repos and build the file scanner as the first library module in `kcd_sdk`, before any KCD knowledge enters the codebase.

**End state:** Both repos initialized with TypeScript tooling. `kcd_sdk` scanner module exists; `scan(root, pattern)` returns `ScannedFile[]` with parsed frontmatter, stripped body, and raw link pairs. No KCD types in the scanner module.

- [x] 0.a Initialize `kcd_sdk` repo at `C:\idt\kcd_sdk` with TypeScript tooling; dependency strategy = `file:../kcd_sdk`
- [x] 0.b Initialize `kcd_mcp` repo at `C:\idt\kcd_mcp`; wire `kcd_sdk` dependency
- [x] 0.c Implement `scan(root, opts?)` in `kcd_sdk` — walks, parses frontmatter (js-yaml), strips body, extracts raw links; smoke-tested against real lens_crafter folder
- [ ] 0.d Unit test: scan against a small fixture directory — deferred; smoke test is sufficient for now

### Phase 1 — KCD Object SDK

**Purpose:** Build `KCDPrimitive` and enough subclasses to validate the dredge pattern end-to-end.

**End state:** `LensObject`, `PlanObject`, and `HabitObject` work; parse → validate → dredgeTargets → toMarkdown round-trips correctly; errors throw with useful messages.

- [x] 1.a `KCDPrimitive` base class — parser chain, error types, dirty flag, serialize/toMarkdown, recursive `dredge()`, flat `nodes`, factory fallback, `serializeForContext`
- [x] 1.b `LensObject` — validateStructure (Know/Care/Do required), table-aware policy parsing, `load(path)` entry point, `getDredgePolicy()`
- [x] 1.e Dredge mechanism — recursive server-side `dredge()` in the base (replaced the client BFS orchestrator); visited set, flat nodes, `collectWrites` already on base
- [ ] 1.c `PlanObject` — phase list, lifecycle fields, policy (cross-refs only)
- [ ] 1.d `HabitObject` — empty policy; leaf node validation
- [ ] 1.f Remaining subclasses: `ReferenceObject`, `ProcedureObject`, `ContractObject`, `TemplateObject`, `FrameworkObject`

### Phase 2 — MCP Server

**Purpose:** Wrap the SDK in a thin MCP server with the 9-tool surface.

**End state:** MCP server starts, builds startup index, responds correctly to all 9 tools over stdio JSON-RPC.

- [ ] 2.a MCP server scaffold (`@modelcontextprotocol/sdk`, stdio transport) — `kcd_mcp`
- [ ] 2.b Startup index: scanner → classifier → indexer
- [ ] 2.c Implement discovery tools: `kcd_glob`, `kcd_list`, `kcd_search`, `kcd_types`
- [ ] 2.d Implement read tools: `kcd_get`, `kcd_links`, `kcd_health`
- [ ] 2.e Implement write tools: `kcd_save` (WriteMap), `kcd_move` (stub with warning for prototype)
- [ ] 2.f Register in Claude Code as a local MCP server; smoke test with real `_Claude/` tree

### Phase 3 — Integration

**Purpose:** Validate the full round-trip: client SDK dredges a lens graph, mutates an object, saves back through MCP.

**End state:** A Node script can load a `LensObject`, traverse its dredge graph, edit a field, and call `kcd_save` — producing the correct file changes on disk.

- [ ] 3.a Wire `kcd_sdk` into a Node integration script
- [ ] 3.b End-to-end test: dredge a lens at depth=1, mutate status, save, verify file on disk
- [ ] 3.c Health report: run `kcd_health()` against full `_Claude/` tree, review output

---

## Files Affected

| Package | Location |
|---|---|
| `kcd_sdk` | `C:\idt\kcd_sdk` — new repo; file scanner + KCDPrimitive library |
| `kcd_mcp` | `C:\idt\kcd_mcp` — new repo; depends on `kcd_sdk` |
| Claude Code MCP config | `.claude/` settings (local registration, Phase 2) |

No existing `_Claude/` content is modified by implementation. The server reads it; it does not rewrite it except through explicit `kcd_save` calls.

---

## Notes

Working notes and research: [mcp-kcd-server-notes](_Claude/work/lens_crafter/AI/mcp-kcd-server-notes.md)

Key decisions that must not drift:
- **Directory wins over frontmatter** for type classification — disagreement is a health issue, not ambiguity
- **The spine orchestrates the dredge; the base is a pure artifact** — `LensObject` owns `projectRoot`, the `readFile()` seam, the flat `nodes`, and the traversal. Every other object just parses itself and exposes `getPolicy()`. No injected `DredgeContext` — information hiding over composition (override `readFile()` for test/UI variation)
- **No graph object** — the parent→child links *are* the graph; a "stub" is an unloaded policy entry on the lens
- **Depth is a decrementing ceiling** — never rises; visited set breaks cycles and protects unsaved ephemeral edits
- **Policy is the What | Where | Why table** — `always` in the Why cell = auto-dredge; conditional rows stay stubs for the agent to evaluate
- **The file reader lives inside the object, server-side** — `LensObject.load(path)` just works; the reader never crosses the IPC boundary
- **`HabitObject` has empty policy** — habits are leaf nodes by design
- **`kcd_save` accepts WriteMap, not a single artifact** — the flat write map is the atomic unit
- **Pure JSON on the wire** — no object instances cross the MCP boundary

---

## Current State

Active — Phase 0 complete; Phase 1 in progress. Built and tested against the real lens_crafter file: `KCDPrimitive` base (pure artifact — parse chain, working stubs, public `getPolicy()`, `collectWrites`), `LensObject` spine (`load(path)`, table-policy parsing, lens-owned dredge orchestration, `serializeForContext`), `io.ts` helpers, `factory.ts` registry. The base→subclass refactor and the `DredgeContext` collapse (information hiding over composition) are done. `dredgeFilter` removed. Not yet committed (Bryan's call).

Next: `PlanObject` (1.c), `HabitObject` (1.d, proves the leaf case), remaining subclasses (1.f). Future: per-child depth-cap override (defense in depth) not yet built; ephemeral pathless objects will need id-keyed nodes (currently path-keyed); section-aware context ordering (Know/Care/Do) is a TODO in `serializeForContext`.
