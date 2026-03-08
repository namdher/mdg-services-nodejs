# Unified Project Contract: MTO + FTD + CAP

## 1. Scope
This contract aligns all teams working on:
- `mdg-services-nodejs` (CAP backend)
- `mdg-front-mto-ui` (MTO UI)
- `mdg-front-ftd-ui` (FTD UI)

Goal: one shared runtime behavior, no parallel rules.

## 2. Source of Truth
- `MDG_FIELD_CATALOG` (field model, VH source/key/text/search)
- `MDG_FIELD_VH_DEPENDENCY` (dependent VH rules)
- `MDG_FIELD_CONTROL_RULE_*` and defaults (mandatory/readonly/hidden/default)
- `MDG_SAP_TARGET` (write targets per process/operation)
- `MDG_BLOCK_SAP_SOURCE` (prefill/read sources per block)

UI and CAP must not hardcode process-specific business rules already configured in HANA.

## 3. Responsibility Split
### CAP (authoritative)
- Resolves VH by metadata.
- Resolves dependencies by metadata.
- Executes SAP integration and multi-step orchestration.
- Applies functional validation and returns controlled errors.
- Persists integration traces and action logs.

### UI (assistive)
- Renders dynamic form from `getFormDefinition`.
- Sends `fieldCode`, `requestId`, `context` for VH requests.
- Handles UX of dependent fields (disable/clear/reload).
- Never calls S/4 directly.

## 4. Value Help Contract
### 4.1 Request
For dependent VH, UI sends:
- `fieldCode` (required for deterministic dependency resolution)
- `requestId` (recommended always)
- `context` (only parent values needed for current VH)
- optional `$search`, `$top`, `$skip`

### 4.2 Dependency precedence in CAP
1. Value from `context`
2. Persisted value from `requestId`
3. Query fallback (when applicable)

If required dependency is missing:
- CAP returns `200` with empty result set (`[]`) unless endpoint-specific functional behavior is explicitly defined.

### 4.3 UI rules (generic)
- If VH has no dependency: send `requestId` only.
- If VH has dependency: send `requestId` + minimal `context`.
- When parent changes: clear child and reload child VH.
- Send full and simple keys in context when applicable (example: `KNVV.VKORG` and `Vkorg`).

## 5. Request Lifecycle Contract
### 5.1 Persistence and save
- `RequestValues` are persisted by CAP.
- CAP should avoid duplicate change-log entries:
  - log only when value effectively changes.

### 5.2 Approve orchestration
- Steps are metadata-driven (targets enabled in `MDG_SAP_TARGET`).
- CAP must execute steps in configured order and stop on required-step failure.
- CAP must not execute disabled targets.
- On retries/rework, CAP must use persisted step state to avoid duplicating completed successful steps.

### 5.3 IDs and cross-step propagation
- IDs returned by SAP in earlier steps are reused in later dependent steps.
- For multi-step processes, CAP persists step results and object keys.

## 6. Observability and Audit
- CAP logs technical trace per SAP step:
  - process/request
  - target/entityset
  - status
  - correlation id (when available)
- CAP stores request SAP messages in `MDG_REQUEST_SAP_MESSAGE`.
- Business comments remain user-facing narrative, not the only technical source.
- CAP logs VH dependency traces:
  - requested fieldCode
  - dependency source (`context`/`request`)
  - applied filter

## 7. Error Contract
- No uncontrolled crashes on null/undefined.
- Functional errors should be explicit and stable.
- Gateway/remote errors should expose useful detail without leaking unsafe payloads.
- OData errors returned by CAP must follow adapter-safe shape.

## 8. Compatibility Rules
- Do not break existing VH entityset names already consumed by UI.
- Do not force UI rewrite for backward-compatible fields.
- Additive model changes are preferred over breaking changes.

## 9. QA Minimum (Cross-team)
- Dependent VH:
  - `VTWEG` without `VKORG` => empty
  - `VTWEG` with `VKORG` => filtered
  - `REGION` without `COUNTRY` => empty
  - `REGION` with `COUNTRY` => filtered
  - `BANKL` without `BANKS` => empty
  - `BANKL` with `BANKS` => filtered
- Multi-step approve:
  - completed steps are not duplicated on retry
  - disabled targets are skipped
- Change log:
  - no duplicate entries when value does not change

## 10. Change Management
- Any contract change must be updated in this file and in `docs/vh-dependency-contract.md`.
- CAP + UI PRs must reference the same contract version/date in description.

