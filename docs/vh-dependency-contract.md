# Value Help Dependency Contract (CAP <-> UI)

## Scope
This document defines the runtime contract for dependent Value Helps exposed by CAP (`/v2/mdg/VH_*`).

## Principles
- UI always calls CAP, never S/4 directly.
- Dependency rules are resolved in CAP from `MDG_FIELD_VH_DEPENDENCY`.
- VH source/key/text/search are resolved in CAP from `MDG_FIELD_CATALOG`.

## Request Contract
For dependent VH requests, UI sends:
- `fieldCode` (required for deterministic dependency resolution)
- `requestId` (recommended always)
- `context` (only parent fields for the current dependent VH)
- `search`, `$top`, `$skip` as needed

Example:
`GET /v2/mdg/VH_CustomerVtweg?$top=50&fieldCode=KNVV.VTWEG&requestId=<REQ_ID>&context={"KNVV.VKORG":"VA50","Vkorg":"VA50"}`

## Dependency Precedence
For each required dependency value, CAP resolves in this order:
1. `context` (exact field code or simple alias)
2. persisted request value (`MDG_REQUEST_FIELD_VALUE` via `requestId`)
3. query filter fallback (if present)

If required dependency value is missing:
- CAP returns `200` with empty result (`[]`).

## UI Behavior (Generic, No Hardcode)
- If VH has no active dependency: send `requestId` only.
- If VH has active dependency: send `requestId` + minimal `context`.
- When parent changes, clear child field and reload child VH.
- Do not send full form state in `context`; send only parent fields of current VH.

## Active Dependency Examples
- `KNVV.VTWEG <- KNVV.VKORG` (`Vkorg`)
- `MVKE.VTWEG <- MVKE.VKORG` (`ProductSalesOrg`)
- `BUT0BK.BANKL <- BUT0BK.BANKS` (`BankCountry`)
- `KNA1.REGION <- KNA1.COUNTRY` (`Country`)
- `BUT000-KNA1.REGION <- BUT000-KNA1.COUNTRY` (`Country`)
- `ADRC.REGION <- ADRC.COUNTRY` (`Country`)

## CAP Technical Trace
CAP logs a dependency trace line per dependent VH call:
- requested `fieldCode`
- each dependency and resolved source (`context`, `request`, `query_filter`, `none`)
- final applied filter sent to S/4

Log tags:
- `[VH_DEP_TRACE]` dependency resolution detail
- `[VH_DEP_MISSING]` required dependency missing

