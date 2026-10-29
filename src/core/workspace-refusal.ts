/**
 * THE shared refusal text for the workspace graph seam (workspace wave
 * Phase 4, docs/workspaces.md decision 9): a session WITHOUT a workspace has
 * no graph destination. Both sides of the seam need the same honest wording —
 * `src/server/stores.ts` mints it on every write of the refusing no-op store;
 * the extraction pipeline (src/agent/subagents/extraction.ts) recognizes it
 * to end an Unsorted run as AbortError BEFORE any model call or ledger write.
 *
 * THE SINGLE SOURCE OF TRUTH: one text, two uses — drift impossible by
 * construction. The recognition on the pipeline side stays lenient
 * (`includes(text)`), so callers may wrap the text with their own prefix
 * (`session <id> …`, `Unsorted …`).
 */
export const WORKSPACE_GRAPH_REFUSAL =
	"has no graph destination — graph extraction is disabled (docs/workspaces.md decision 9: Unsorted sessions write no graph).";
