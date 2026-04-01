# Unified compliance permissions

Status: implemented

This is the single maintainer-facing design document for shipped compliance enforcement in `packages/opencode`.

It replaces the earlier split between:
- `specs/bash-compliance-ceiling.md`
- `specs/unified-compliance-permissions.md`

The current branch implements one compliance system that covers:
- runtime permission ceilings such as bash command restrictions
- whole-tool visibility rules such as `websearch: "deny"`
- canonical permission aliasing for edit-family tools

## Goals

1. Keep personal `opencode.json` and agent/session permissions working.
2. Add a shipped compliance policy that local config cannot relax.
3. Reuse the existing `permission` schema instead of inventing a second policy format.
4. Keep tool pre-filtering and runtime permission checks consistent.
5. Keep the patch small enough that upstream rebases stay manageable.

## Scope and non-goals

In scope:
- shipped policy in `src/permission/compliance.json`
- runtime permission ceilings in `Permission.ask(...)`
- `reply("always")` approval ceilings
- tool visibility / disabled filtering
- canonical permission-name guidance for edit-family tools

Out of scope:
- managed-config trust hardening
- plugin override hardening
- a second `tool.disabled` schema
- changing global rule semantics in `src/permission/evaluate.ts`
- making every pattern-level deny hide an entire tool

## Canonical policy shape

The shipped policy intentionally reuses the normal config `permission` shape from `src/config/config.ts:510-535`.

That schema supports:
- `PermissionAction` such as `"websearch": "deny"`
- `PermissionRule` objects such as:

```json
{
  "bash": {
    "*": "deny",
    "pwd *": "ask",
    "ls *": "allow",
    "git *": "ask"
  }
}
```

The compliance loader in `src/permission/compliance.ts:16-18` and `src/permission/compliance.ts:34-53` parses the shipped JSON once, normalizes it into rules, and reuses the same rule model as normal permissions.

## Current shipped policy on this branch

Current file:
- `src/permission/compliance.json`

Current contents:

```json
{
  "permission": {
    "bash": {
      "*": "deny",
      "pwd *": "ask",
      "ls *": "allow",
      "git *": "ask"
    },
    "webfetch": "ask",
    "websearch": "deny",
    "interactive_bash": "deny"
  }
}
```

Important implementation note:
- `bash`, `webfetch`, and `websearch` are exercised directly by current implementation paths and tests.
- `interactive_bash` is also accepted by the generic permission schema and whole-tool disable path because compliance keys are loaded through the generic `permission` ruleset (`src/config/config.ts:533-535`, `src/permission/compliance.ts:34-53`, `src/permission/index.ts:307-317`).

## Canonical permission names and aliases

The design uses **permission names**, not always raw tool ids, as the enforcement boundary.

### Edit-family tools share `edit`

Current implementation:
- `src/permission/index.ts:305-317`
- `src/config/config.ts:622-632`
- `src/config/config.ts:1436-1444`
- `src/tool/write.ts:35-42`
- `src/tool/edit.ts:65-72`
- `src/tool/apply_patch.ts:177-184`

Behavior:
- `write`
- `edit`
- `apply_patch`
- `multiedit`

are all treated as the canonical permission:

```text
edit
```

Consequences:
- a config/compliance rule for `edit` applies to all four tools
- a config/compliance rule for `write` alone does **not** block the write tool in the current implementation
- maintainers should encode edit-family policy with `edit`, not `write`

This is already the branch’s implemented behavior, not a proposed future change.

### Bash remains its own runtime permission

Current implementation:
- `src/tool/bash.ts:265-285`

`tool/bash.ts` extracts command patterns and asks for:

```text
permission: "bash"
```

That is why bash command policy belongs in runtime permission evaluation rather than in a separate shell-specific system.

## Runtime enforcement design

All runtime permission checks still flow through `Permission.ask(...)`.

Relevant implementation:
- `src/permission/index.ts:139-140`
- `src/permission/index.ts:175-189`
- `src/permission/compliance.ts:68-72`

The effective rule is computed in two stages:
1. evaluate the normal rulesets first (`config`, `approved`, etc.)
2. apply shipped compliance for the same permission/pattern and keep the stricter result using:

```text
deny > ask > allow
```

Examples with current behavior:
- local `allow` + compliance `ask` => `ask`
- local `allow` + compliance `deny` => `deny`
- local `deny` + compliance `allow` => `deny`

This is implemented generically, so it applies to any permission represented in `compliance.json`, not only bash.

## `reply("always")` ceilings

Current implementation:
- `src/permission/index.ts:247-257`

`reply("always")` persists `allow` approvals into the `approved` ruleset, then checks pending requests again through the same `effective(...)` path.

That means shipped compliance also caps persistent approvals:
- a compliance `ask` cannot be promoted to implicit `allow`
- a compliance `deny` cannot be bypassed by session-level “always allow”

## Tool visibility / disabled filtering

Tool pre-filtering still flows through `Permission.disabled(...)`.

Relevant implementation:
- `src/permission/index.ts:305-317`
- callers:
  - `src/session/llm.ts:346-351`
  - `src/session/system.ts:61-64`
  - `src/cli/cmd/debug/agent.ts:77-84`

### Coarse-grained contract

`disabled()` is intentionally coarse-grained.

It answers:
- should the whole tool be hidden from the model/UI?

It does **not** answer:
- should one specific sub-pattern be denied at runtime?

That split is intentional:
- whole-tool visibility belongs in `disabled()`
- pattern-aware execution belongs in `ask()`

### Current whole-tool disable rule

The current branch disables a tool only when the effective tool-level rule is a wildcard deny.

For local rules this lives in:
- `src/permission/index.ts:315-317`

For shipped compliance this now lives in:
- `src/permission/compliance.ts:75-79`

Important detail:
- `Compliance.disables(permission)` now mirrors the same coarse heuristic as `Permission.disabled(...)`
- it no longer uses `evaluateRule(permission, "*")` as the whole-tool test
- this prevents `bash` default-deny-with-exceptions from disappearing as a tool

### Behavior examples

#### Effective whole-tool deny

Examples:
- `"websearch": "deny"`
- `"edit": "deny"`

Result:
- tool hidden from the model/UI
- runtime use also denied

#### Whole-tool ask

Example:
- `"webfetch": "ask"`

Result:
- tool remains visible
- runtime still asks

#### Pattern-specific runtime policy

Example:

```json
{
  "bash": {
    "*": "deny",
    "pwd *": "ask",
    "ls *": "allow",
    "git *": "ask"
  }
}
```

Result:
- `bash` stays visible
- `ls *` allowed
- `pwd *` asks
- `git *` asks
- unmatched commands deny at runtime

This is the behavior fixed on the current branch by aligning `Compliance.disables(...)` with the coarse tool-filter contract.

## Why a separate `tool.disabled` schema was rejected

Rejected alternative:
- introduce a second compliance namespace such as `tool.disabled`

Reason:
- the existing `permission` schema already models both whole-tool actions and pattern-based rules
- a second schema would increase review surface and drift risk
- current implementation stays smaller by keeping everything in one ruleset

## Implementation caveat: non-canonical keys can be accepted silently

The compliance parser accepts arbitrary permission keys via:
- `src/config/config.ts:533-535`
- `src/permission/compliance.ts:16-18`

That means non-canonical keys can be accepted even when the effective implementation path resolves the tool through a different canonical permission.

Example consequence:
- a hypothetical compliance entry like `write: "deny"` would be parsed
- but edit-family tools still consult `edit`
- therefore the rule does not block the `write` tool in practice

Maintainer guidance:
- use canonical permission names in shipped compliance
- for edit-family tools, use `edit`

## Tests and verification

Main regression coverage:
- `test/permission/next.test.ts`

Focused areas now covered:
- shipped compliance expectations for bash/webfetch/websearch
- disabled behavior for whole-tool deny vs ask
- bash remains visible under default-deny-with-exceptions
- runtime ask/deny ceilings
- `reply("always")` cannot exceed compliance ceilings

Useful implementation-aligned anchors:
- shipped policy assertions: `test/permission/next.test.ts:371-378`
- disabled coverage: `test/permission/next.test.ts:416-505`
- bash ask ceiling coverage: `test/permission/next.test.ts:609-666`
- always-approval ceiling coverage: `test/permission/next.test.ts:893-956`

Focused bash tool verification:
- `test/tool/bash.test.ts`

Current branch verification already run:
- `bun test test/permission/next.test.ts`
- `bun test test/tool/bash.test.ts -t 'asks for bash permission with correct pattern'`
- `bun typecheck`
- `bun run build`

## Maintenance guidance

### When updating shipped policy

1. Edit `src/permission/compliance.json`.
2. Keep using canonical permission names.
3. Prefer the existing `permission` shape.
4. Add or update regression tests before changing semantics.
5. Re-run:
   - `bun test test/permission/next.test.ts`
   - `bun test test/tool/bash.test.ts -t 'asks for bash permission with correct pattern'`
   - `bun typecheck`
   - `bun run build`

### Choosing the right key

- Use `websearch`, `webfetch`, `bash`, `edit`, etc. as canonical permission names.
- Use `edit` for `write` / `edit` / `apply_patch` / `multiedit`.
- Do not assume every tool id is also the correct compliance key.

### When rebasing on upstream

Review these files first:
- `src/config/config.ts`
- `src/permission/compliance.ts`
- `src/permission/index.ts`
- `src/permission/evaluate.ts`
- `src/session/llm.ts`
- `src/session/system.ts`
- `src/cli/cmd/debug/agent.ts`
- `src/tool/bash.ts`
- `src/tool/write.ts`
- `src/tool/edit.ts`
- `src/tool/apply_patch.ts`

What to look for:
- changes to permission schema or permission-name aliases
- changes to tool-list filtering before model exposure
- changes to the `edit` alias path for write-family tools
- changes to `Permission.ask(...)` or `reply("always")`
- changes to bash pattern extraction

## Related artifacts

- `.omx/plans/opencode-option2-compliance-plan.md`
- `.omx/plans/opencode-unified-compliance-disabled-plan.md`
- `.omx/plans/compliance-disable-semantics-plan-20260401.md`
- `.omx/artifacts/claude-disabled-design-20260331T173451Z.md`
- `.omx/artifacts/claude-unified-compliance-disabled-plan-20260331T175228Z.md`
- `.omx/artifacts/claude-compliance-plan-config-semantics-20260401-095219.md`
- `.omx/artifacts/claude-compliance-fix-review-20260401-101627.md`
- `.omx/artifacts/claude-write-deny-analysis-20260401-104240.md`

This file is the source of truth for the current branch’s shipped compliance design.
