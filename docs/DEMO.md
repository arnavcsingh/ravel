# Demonstrating Ravel

Run `pnpm install`, then `pnpm demo`, and open http://127.0.0.1:4317. The initial run contains one stale hazard and one downstream artifact.

## Ten-second explanation

“Backend read the integer schema. Database changed the identifier to UUID while Backend worked. Backend published numeric types anyway, and Frontend used them. Ravel shows the exact observations, versions, and causal chain.”

Point at the shaded stale interval, red `types.ts@5`, and downstream `client.ts@9`. The diff shows UUID while the generated interface still uses `number`.

## Show the real interleaving

Leave **Pause before the stale write commits** checked and click **Run live demo**. Backend reads its input and produces a write intent. Ravel holds it before validation while Database commits its migration. The banner appears after the change; no stale output has been committed yet.

Click **Release pending write**. The coordinator compares captured inputs with current heads, commits the stale artifact in Observe mode, and records provenance and the hazard in one SQLite transaction. Frontend then consumes the published types. No sleep establishes this order.

## Replay and repair

**Replay race** animates five stored events: observation, invalidation, output, downstream observation, downstream output. It does not rerun an LLM.

Click **Jump to latest**, then **Repair demo**. Both affected heads become clean. Old red/amber graph nodes and the historical incident remain visible.

Choose **Guard and retry** for the next run. Guard rejects the held stale write and starts a new backend attempt. This is deterministic content validation; no model decides whether publication is safe.

## Scope

- The in-process Go demo scripts are conformance fixtures. External Python agents use the provider-independent HTTP session client.
- Semantic explanation uses a labeled fixture heuristic.
- Downstream reachability does not prove incorrectness.
- Guard is per write; general staging/rollback is not implemented.
- Gemini and Fetch Python interfaces have no installed transports. SpacetimeDB and further integrations are deferred. No keys are required.

## Reset

Stop the server, run `pnpm demo:reset`, then `pnpm demo`. Reset archives the previous data instead of deleting history. For another instance, use a different `RAVEL_DATA_DIR` and `PORT`.
