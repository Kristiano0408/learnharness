# Workspaces — piano di implementazione

Stato: **Fasi 1–6 implementate (2026-10-28/29)**; Fase 7 verificata/chiusa (2026-10-29). Questo documento è la fonte di verità per
riprendere il lavoro in qualsiasi sessione futura. Ogni fase è implementabile e
testabile da sola; le fasi sono ordinate per dipendenza.

> **Fase 1 fatta:** `src/core/contracts/workspace.ts` (WorkspaceRecord/WorkspaceSummary/
> CURRENT_WORKSPACE_VERSION), porta `WorkspaceStore` in `src/core/ports.ts`, adattatore
> `src/store/workspaces.ts` (data/workspaces/<id>/meta.json, mkdir al choke point,
> tie-break id nell'ordine createdAt), `PATHS.workspaces` in `config.ts`, evento
> `workspaces-changed` nel bus, wiring in `src/server/stores.ts`, test
> `tests/workspace-store.test.ts` (9 pass).
>
> **Fase 2 fatta:** `workspaceId` su `ChatRecord`/`ChatSummary` (assente = Unsorted,
> nessuna migrazione); `ChatStore.createChat(title, kind?, workspaceId?)` +
> `moveChat(id, workspaceId | null)` (annuncia chats-changed, updatedAt fermo);
> `WorkspaceListItem` (summary + busyCount); `src/server/workspaces.ts`
> (listWorkspaceItems con i fold sessionCount/busyCount, workspaceExists,
> moveChatSession con gate 404/400/409 turn/extraction, deleteWorkspaceGuarded
> 409 not_empty); rotte `GET/POST /api/workspaces`, `PUT/DELETE /api/workspaces/[id]`,
> `PUT /api/chats/[id]/workspace`, gate filing in `POST /api/chats`; export dal
> barrel server. Test: `tests/workspace-api.test.ts` (5 pass) + pin moveChat in
> `tests/chat-store-events.test.ts`. **Nota per Fase 5** (ora fatta): la
> rotta move accetta `?mode=move-session|move-nodes` — il trasporto dei trace è
> implementato in `src/core/graph-deletion.ts` + `src/server/workspaces.ts`.
>
> **Fase 3 fatta:** fold puro `src/core/workspace-groups.ts` (UNSORTED_KEY,
> FILTER_DEFAULT_KEY, DRAFT_WORKSPACE_KEY, groupChatsByWorkspace — Unsorted primo
> solo se non vuoto, workspaceId sconosciuto legge Unsorted, workspace vuoti
> restano visibili; readKindFilters con migrazione lazy del valore legacy bare
> string → default "*"; kindFilterFor/withKindFilter/filterChatsByKind — kind
> assente legge teach), export dal barrel core. Sidebar (`components/sidebar.tsx`):
> sezioni collassabili per workspace (Unsorted primo, mai collassabile), header
> con caret/nome (rename inline)/spinner busy/count + coppia rename/delete hover
> (assenti per Unsorted), conferma delete inline (409 not_empty → alert + refresh),
> riga "+ New workspace", KindFilterRow PER SEZIONE (il filtro globale è rimosso;
> la riga resta visibile anche quando il filtro svuota la sezione), query di ricerca
> = lista flat camminabile, otherwise walk sugli `[data-testid="session-row"]` in
> ordine di sezione; `workspaces-changed` → refresh. Dialog `components/
> move-session-dialog.tsx` (MoveSessionBody puro esportato per pin SSR; v1
> move-session-only, il seam del secondo modo A3 è riservato per Fase 5). Chip di
> filing nel draft: `WorkspaceChip` in `components/composer-actions.tsx` + wiring in
> `components/new-session.tsx` (default persistito DRAFT_WORKSPACE_KEY, il POST
> porta workspaceId) e `SessionCreation.workspaceId` in `components/start-session.ts`.
> Menu contestuale sessione: "Move to workspace…" prima di delete (danger-fence).
> Test: `tests/workspace-groups.test.ts` (10 pass) + `tests/workspace-sidebar.test.tsx`
> (11 pin SSR). Suite completa: 2563 pass, 0 fail; typecheck+lint puliti.
>
> **Fase 4 fatta:** factory `createGraphStore(files)` + `LEGACY_GRAPH_FILES` (`src/store/graph.ts`); `graphFilesForDir`/`WORKSPACE_ID_PATTERN` in `config.ts` + stamp formato per cartella (`graph-format.ts` accetta un host per dir); `graphStoreFor(id)` con cache Map, `refusedStore` (no-op onesto, scrittura rifiutata), `graphStoresForChat` (resolver forChat/forWorkspace), `purgeWorkspaceGraphStore` (droppato prima della cancellazione della cartella) — tutto nel composition root `src/server/stores.ts`. Rifiuto condiviso: `WORKSPACE_GRAPH_REFUSAL` (`src/core/workspace-refusal.ts`) sigillo testuale, `GraphStore.refused` = sigillo strutturale (la pipeline lo riconosce con `isRefusedStore`). Seam di lettura: `graphStoreForChatRead(chatId)` = store legacy per sessioni senza workspaceId (decisione 9 vieta NUovi scritti legacy, mai letture). Chiamanti: `runExtraction` risolve lo store dal record (lettura fresca); `runNotesExtraction` trasporta `input.graphStore` (notes→workspace), `importNotes(input, workspaceId?)` (picker); `triggerExtraction` legge copertura dallo store della sessione; `deleteChatSession` esegge il purge nello store della sessione; `sessionCoverage`/`commitPositions`/agent graph tools cavalcano lo store giusto. `graphView`/`graphCosts`/`graphRevision(scope)` hanno il selettore (default legacy = comportamento pre-Fase identico byte-per-byte); rotte con gate `?workspace` (404 sconosciuto): `/api/graph`, `/api/graph/costs`, `/api/graph/positions`, `/api/graph/nodes/[id]`, `/api/graph/import` (field "workspace", gate 400). Notes import picker (`components/notes-import.tsx` `setWorkspace`). Test: `tests/workspace-graph.test.ts` (4 pass: isolation A/B, refusal Unsorted, legacy invariato, cache/purge). Suite: 2567 pass, 0 fail; typecheck pulito.
>
> **Fase 5 fatta:** il trasporto dei trace `mode=move-nodes` (decisioni owner 2026-10-29: copy checkbox = specchio TRACES_COPY del dialog di cancellazione; destinazione Unsorted = checkbox visibile ma disabilitato con riga onesta dentro il suo body; posizioni = copy+prune; morte origin = morte completa per i nodi pienamente owned). Nucleo puro in `src/core/graph-deletion.ts`: `takeChatTraces` (fedele alla cancellazione: nodi condivisi sopravvissuti con provenance foreign, identità preservata dove la create-line emptied è rimasta; chain union key-con-gestita destinatione per stile link-style; re-mint `n_`/`arg_` quando collisiona un id già posseduto dalla destinazione) + delta portato (coverage/checkpoint sempre in trasporto, positions copiate prima del prune). Orchestrazione server `moveChatSessionGraph(chatId, mode, workspaceId)` (`src/server/workspaces.ts`): gate bad_mode/404/unknown_workspace/turn_in_flight/extraction_running/no_graph_destination; blocco sincronizzato take → land → moveChat finale. Rotta `PUT /api/chats/[id]/workspace?mode=` accetta `move-session` (default) e `move-nodes`; payload restituisce stats + timbri di revisione origin/destination (`{origin, destinationScope, destination}`). Sidebar: `onMoved(id, workspaceId?, revisions?)` annuncia due timbri scoped `lh:graph-revision` all'ospite; il match di scope è governato da `graphRevisionScopeMatches(detail, currentWorkspace)` (esportato puro, pronto per i pin). Dialog `components/move-session-dialog.tsx`: checkbox `MOVE_TRACES_COPY` sempre visibile ma disabilitato verso Unsorted (`move-traces-unsorted` riga onesta al suo interno), stato `traces` azzerato su chiusura/cambio target. Test: `tests/workspace-move.test.ts` (23 pass: take/land core, orchestrazione server, seam della rotta, pin scoped) + `tests/workspace-sidebar.test.tsx` esteso (14 pass SSR). Suite: 2542 pass, 0 fail; typecheck pulito.
>
> **Fase 6 fatta:** il selettore workspace nella graph view (decisioni C1 + owner
> 2026-10-29 sopra). Server: `scopedReadStore(workspaceId)` (`src/server/graph.ts`)
> è la lettura onesta per tutte le bande lettrici (`graphView`/`graphCosts`/
> `deleteGraphNode`): assente/"global" = legacy; workspace noto = il suo store;
> id valido ma sconosciuto = `refusedReadStore` (letture vuote, 404 onesto "No
> such node", mai un throw). Timbri scoped: `deleteChatSession` timbra lo scope
> della sessione (`purgeScope`); `moveChatSessionGraph` restituisce
> `originScope`/`destinationScope` (move-session = null/null, move-nodes = gli
> scope reali), la rotta li trasporta nel payload. Client: `components/graph-view.tsx`
> — `GraphScopeControl` (dropdown A, testid `graph-scope-select`/`graph-scope-option-*`,
> ✓ sull'opzione attiva), opzioni pure `graphScopeOptions` (Global (legacy) primo,
> workspaces in ordine store, Unsorted MAI opzione), persistenza
> `lh:graph-workspace` (`GRAPH_WORKSPACE_STORAGE_KEY`) con lettura onesta
> `readGraphWorkspaceScope` (solo un workspace id conta; "global"/corrotto =
> Global; una workspacevanished cade su Global e lo stamp muore); camera per-scope
> (`cameraStorageKey`, ruling 12 — bare key = legacy, sufficio `:id` per workspace);
> snapshot/costs/commit-positions/nodes-DELETE cavalcano l'URL scoped
> (`?workspace=<id>`), gli annunci `lh:graph-revision` portano lo scope
> (`{revision, scope}`) e `graphRevisionScopeMatches` governa chi riflette; il
> selettore è SEMPRE visibile (ruling 13), prima del search nella riga controlli;
> `delete-node-dialog.tsx` e `ChainTableOverlay` propagano `workspaceId` (DELETE
> scoped + annuncio scoped); sidebar `onMoved` annuncia i due timbri con gli scope
> del payload. Notes import picker: seam Phase 4 già innescato dal selettore
> (`notesImport.setWorkspace(scope)`). Test: `tests/workspace-selector.test.ts`
> (11 pass: rotte scoped + gate onesti, isolation end-to-end, timbri scoped
> delete/move, pin puri del seam client — persistenza, opzioni, camera, chrome SSR
> isEmpty). Suite: 2553 pass, 0 fail; typecheck+lint puliti.
>
> **Fase 7 fatta (verifica + chiusura, 2026-10-29):** suite completa verde
> deterministica (no LLM, no network); `tsc --noEmit` + eslint puliti su tutto
> il tree; nessun errore sui file toccati dal wave. Fix e pin di chiusura: la
> URL DELETE del dialog nodo cavalca `?workspace=` (`&` standalone era un gate
> morto — URL senza query) estratta come seam puro `deleteNodeUrl(nodeId,
> workspaceId?)`; le URL lette della graph view (snapshot/costs/positions)
> confluiscono in `graphScopedUrl(path, workspaceId)`; l'annuncio scoped
> di cancellazione muore in `announceScopedRevision(graphRevision, workspaceId?)`
> (chain-table + graph-view cavalcano lo stesso helper, export puro). Pin
> aggiunti: `tests/workspace-selector.test.ts` (13 pass: URL contract scoped
> del client + annuncio `{revision, scope}` via linkedom window). docs/
> architecture.md aggiornato al wave 1–6. Suite finale: 2555 pass, 0 fail;
> typecheck+lint puliti.

## Decisioni prese (owner, 2026-10-28)

1. **Un workspace ha il proprio graph** (1B): la raggruppazione serve a questo.
   Ogni workspace possiede i suoi ledger graph in `data/workspaces/<id>/graph/`.
2. **Workspace opzionale** (2B): `workspaceId` assente sul record = sessione
   "Unsorted" (le sessioni sparse di oggi restano così, nessuna migrazione).
3. **Creazione: entrambi i punti d'accesso** (3C): pulsante "+ New workspace"
   nella sidebar + scelta del workspace nel flusso di nuova sessione.
4. **Sidebar: sezioni collassabili per workspace** (4C), sessioni annidate sotto,
   ordine invariato dentro ogni sezione. **Il filtro kind (Teaching/All/Practice)
   è per workspace** (persistito per workspace).
5. **Spostare sessioni tra workspace: serve subito** (risposta 5), con la
   **modalità A3**: al momento dello spostamento un dialog chiede all'utente,
   come già fa la cancellazione sessione:
   - `move-session` — sposta solo la sessione; i contributi graph mergiati
     restano nel graph di origine.
   - `move-session-and-nodes` — migrano anche le tracce graph della sessione
     (righe nodes/chains/coverage/checkpoint con provenance di quella
     sessione) nel graph di destinazione; i nodi condivisi con altre sessioni
     restano anche nell'origine.
6. **Nomenclatura: `workspace` ovunque** (6): `WorkspaceRecord`, `workspaceId`,
   UI "Workspace".
7. **Basi per il futuro già ora** (7): `WorkspaceRecord` include i campi
   riservati `rootPath` (cartella reale già esistente con file dentro — futura
   apertura) e `linkedWorkspaceIds` (futuro collegamento tra workspace/graph).
   Assenti = non usati.
8. **Archiviazione: una cartella per workspace** (8): `data/workspaces/<id>/`
   con `meta.json` + `graph/` dentro.
9. **Graph globale esistente** (B): `data/graph/` **resta dov'è** — è il graph
   delle sessioni Unsorted? **No**: le sessioni Unsorted **non hanno un graph
   condiviso**. Il graph globale resta lì, non più scritto dalle nuove sessioni
   senza workspace; in futuro potrà diventare un collegamento tra workspace.
   Le sessioni senza workspace non scrivono graph (l'estrazione per una
   sessione Unsorted è disattivata: nessuna destinazione).
10. **Graph view (C1)**: selettore di workspace nella graph view (incluso
    "Global (legacy)" per `data/graph/`); mostra il graph selezionato.

**Decisioni Fase 6 (owner, 2026-10-29):**

11. **Selettore: dropdown nella riga controlli** (A): un dropdown nella riga
    controlli della graph view (sostituisce l'idea di chip/tab-bar), prima del
    campo search; testid `graph-scope-select` + opzioni `graph-scope-option-<id>`.
12. **Camera per scope** (sì): zoom+pan persistono per il graph a cui
    appartengono — la chiave nuda `lh.graph.camera.v1` è il global legacy,
    `lh.graph.camera.v1:<workspaceId>` per ogni workspace (`cameraStorageKey`,
    flushed su unmount e cambiato-scope).
13. **Selettore sempre visibile** (sì): anche su graph vuoto/isEmpty — lì è
    l'unica azione vera (destinazione dell'import).

## Architettura di riferimento (verificata)

- Sessioni: `data/chats/<id>.json` (`ChatRecord`), store fs sync
  `src/store/chats.ts`, porta `ChatStore` in `src/core/ports.ts`, composition
  root `src/server/stores.ts`.
- Graph: ledger append-only `config.LEDGER_FILES` (`data/graph/*.jsonl`) +
  `positions.json` + `sources.json`; store `src/store/graph.ts` (porta
  `GraphStore`); derivazione pura in `src/core/graph.ts` che prende
  `GraphDeps { chatStore, graphStore }` come parametri espliciti — **il seam
  per il graph-per-workspace è già naturale: si passa un graphStore diverso**.
- Pipeline estrazione: `src/agent/subagents/extraction.ts`
  (`ExtractionPipelineDeps extends GraphDeps`) — tutto il graph-write passa da
  lì con il graphStore iniettato.
- Eventi: bus `src/core/events.ts` (`ServerEvents`), SSE `GET /api/events`;
  legge SILENCE LAW: solo le mutazioni di forma della lista annunciano
  (`chats-changed`).
- Sidebar: `components/sidebar.tsx` — lista piatta ordinata per `updatedAt`,
  filtro kind localStorage `lh:session-kind-filter`, ricerca fuzzy, menu
  contestuale (Rename/Delete + coverage), eventi `lh:chat-renamed`,
  `lh:turn-state`, `useServerEvent("chats-changed"…)`.
- Versione record: `CURRENT_CHAT_VERSION = 1`, LAZY stamping (assenza = v1,
  ogni write stampa la corrente; record più nuovo del build = rifiuto onesto).

## Fase 1 — Workspace contracts + store

**File:** `src/core/contracts/workspace.ts` (nuovo dominio barrel),
`src/core/contracts.ts` (riesporta), `src/core/ports.ts` (porta),
`src/store/workspaces.ts` (adattatore fs), `src/server/stores.ts` (wiring),
`config.ts` (`PATHS.workspaces`).

```ts
// contracts/workspace.ts
export interface WorkspaceRecord {
  id: string;              // "ws_" + ts36 + rand8 — stesso idiom dei chat id
  name: string;
  createdAt: string;
  updatedAt: string;
  /** RISERVATO (decisione 7): cartella reale già esistente che il workspace
   *  aprirà in futuro con i suoi file. Assente = workspace solo logico. */
  rootPath?: string;
  /** RISERVATO (decisione 9): futuri collegamenti tra workspace. */
  linkedWorkspaceIds?: string[];
  /** SCHEMA STAMP — stesso regime lazy dei chat record. */
  version?: number;
}
export const CURRENT_WORKSPACE_VERSION = 1;

export interface WorkspaceSummary {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  sessionCount: number;    // fold su chatStore.listChats() nel servizio, NON nello store
}
```

```ts
// ports.ts
export interface WorkspaceStore {
  createWorkspace(name: string): WorkspaceRecord;
  getWorkspace(id: string): WorkspaceRecord | null;
  listWorkspaces(): WorkspaceRecord[];   // ordine createdAt (stable), non updatedAt
  renameWorkspace(id: string, name: string): WorkspaceRecord;
  deleteWorkspace(id: string): boolean;  // v1: rifiuto se ha sessioni (409) — vedi Fase 5
}
```

Adattatore: `data/workspaces/<id>/meta.json` (read-modify-write, tmp+rename
come `writePositionMap`), id-guard come `chatFile()`. `createWorkspace` emette
`workspaces-changed`.

**Test:** `tests/workspace-store.test.ts` — create/get/list/rename/delete,
guardia id, rifiuto versione futura, isolamento (backup/clear di
`data/workspaces` come `tests/graph.test.ts` fa con i ledger).

## Fase 2 — `workspaceId` sul record sessione + API

- `ChatRecord.workspaceId?: string` (assente = Unsorted, nessuna migrazione —
  stesso regime di `kind`).
- `ChatSummary.workspaceId?: string` (copia nel fold di `listChats`).
- `ChatStore.createChat(title, kind?, workspaceId?)` — il POST /api/chats
  accetta `workspaceId` nel body (validato: workspace esistente o assente).
- `ChatStore.moveChat(id, workspaceId | null)` — write + `chats-changed`
  (mutazione di forma lista).
- Nuove rotte:
  - `GET /api/workspaces` → `{ workspaces: WorkspaceListItem[] }`
    (summary + `sessionCount` + `busyCount` fold server-side, stesso pattern
    di /api/chats).
  - `POST /api/workspaces` `{ name }` → `{ id, name }`.
  - `PUT /api/workspaces/[id]` `{ name }` (rename, updatedAt non bumpato —
    stessa regola dei rename chat).
  - `DELETE /api/workspaces/[id]` — v1: 409 `not_empty` se ha sessioni.
  - `PUT /api/chats/[id]/workspace` `{ workspaceId | null }` — il move
    (modalità A3 del dialog: `move-session` semplice qui; il trasporto dei
    nodi è Fase 5, fatta: `mode=move-nodes`).
- Nuovo evento bus: `"workspaces-changed": Record<string, never>` in
  `ServerEvents` + `SERVER_EVENT_TYPES`.

**Test:** `tests/workspace-api.test.ts` (rotte) + estensione
`tests/chat-kind.test.ts`-style per il campo record.

## Fase 3 — Sidebar: sezioni per workspace

`components/sidebar.tsx`:

- Fetch di `/api/workspaces` insieme a `/api/chats` (stesso refresh/debounce
  eventi; `useServerEvent("workspaces-changed", …)`).
- Rendering: sezione "Unsorted" prima (sessioni senza workspaceId), poi un
  blocco per workspace: header con nome (click-to-rename inline, stessa
  geometria di RenameRow), caret collassabile, sessioni sotto.
- Stato collasso persistito: `lh:workspace-collapsed` (JSON map id→bool).
- **Filtro kind per workspace** (decisione 4): `lh:session-kind-filter`
  diventa map workspaceId→filter (Unsorted = chiave `"unsorted"`); migrazione
  lazy del valore vecchio (stringa → map con lo stesso valore per tutti).
- Ricerca fuzzy: quando la query è attiva, le sezioni si appiattiscono
  (tutti i match listati piatti, come oggi) — la query vince sulla struttura.
- Menu contestuale sessione: aggiunge "Move to workspace…" → dialog (Fase 5, fatta:
  `move-session-dialog.tsx` con checkbox `MOVE_TRACES_COPY`).
- "+ New workspace" sotto i due pulsanti "New session" (name inline, Enter
  crea).
- Il flusso nuova sessione: nel draft view, un picker workspace (default:
  l'ultimo workspace attivo o Unsorted) — il POST porta `workspaceId`.

**Test:** render test esistenti sidebar (se esistono pattern di test DOM,
estenderli); `timeAgo`-style pure helpers estratti e testati (gruppo/sezione
`groupChatsByWorkspace(chats, workspaces)` pura in `src/core/`).

## Fase 4 — Graph per workspace (il pezzo pesante)

Principio: **nessun cambiamento alla derivazione core** — `core/graph.ts`
prende già `GraphDeps` espliciti. Si cambia SOLO il wiring.

- `config.ts`: `workspaceGraphDir(workspaceId)` →
  `path.join(PATHS.workspaces, workspaceId, "graph")` + una funzione
  `ledgerFilesFor(workspaceId | null)`:
  - `null` (Unsorted) → **nessun graph** (decisione 9).
  - workspace → ledger dentro la cartella del workspace.
- `src/store/graph.ts`: refactor dell'adattatore da costanti di modulo a
  **factory**: `createGraphStore(files: LedgerFiles): GraphStore` — l'istanza
  legacy `graphStore` (data/graph) resta per il graph globale legacy
  (lettura: graph view "Global (legacy)", provenance vecchie); per ogni
  workspace si costruisce il suo store. `graph-format.ts` stamp per cartella.
- `src/server/stores.ts`: `graphStoreFor(workspaceId | null): GraphStore` —
  cache Map per id; `null` → store NO-OP onesto (append rifiuta con errore
  chiaro "session has no workspace — graph extraction disabled"; letture
  vuote).
- Chiamanti dell'estrazione (`src/server/chat-handler.ts`,
  `src/server/turn-service.ts`, `src/agent/subagents/extraction.ts`):
  risolvono il graphStore dal workspaceId del chat record al momento del run
  (lettura fresca del record). `ExtractionPipelineDeps` invariato nella forma
  (`GraphDeps`), è il chiamante a scegliere lo store.
- Layout/positions: `positions.json` per workspace (stesso seam
  `writePositions`), settle per-workspace (il settle è già full-graph sul
  graphStore passato).
- Notes import: il workspace si sceglie all'import (picker); i sorgenti notes
  vivono nel workspace scelto (`sources.json` per workspace).
- Cost summary graph (`graphCosts`): fold per workspace + legacy.

**Test:** `tests/workspace-graph.test.ts` — due workspace con graph isolati
(merge nel workspace A non visibile dal snapshot del workspace B); sessione
Unsorted → estrazione disattivata (rifiuto onesto, nessun ledger scritto);
legacy graph leggibile invariato.

## Fase 5 — Spostare sessioni (dialog A3) — **fatta 2026-10-29**

Implementato come da piano, con le decisioni owner raccolte in sessione (copy
checkbox speculare al dialog di cancellazione; destinazioni Unsorted disabilitate
onestamente: nessun destinazione del graph lì — decisione 9; posizioni copy+prune;
 morte origin completa per nodi pienamente owned):

- `components/move-session-dialog.tsx` extend: checkbox `MOVE_TRACES_COPY` esportato puro
  per pin SSR, sempre visibile ma disabilitato verso Unsorted con riga onesta dentro il suo body.
- `PUT /api/chats/[id]/workspace?mode=move-nodes`: orchestrazione server via
  `moveChatSessionGraph` in `src/server/workspaces.ts` (gate bad_mode/404/
  unknown_workspace/turn_in_flight/extraction_running/no_graph_destination; blocco
  sincronizzato take → land → moveChat finale); payload = stats + timbri revisione origin/destination.
- Nucleo puro `takeChatTraces`/`landChatTraces` in `src/core/graph-deletion.ts`:
  - lette le righe dei ledger di origine fedeli alla cancellazione (nodi pienamente
    owned muoiono; nodi condivisi sopravvivono con provenance foreign + phrasings della
    sessione che trasporta; create-line emptied re-mast in origine, aliases stripped);
  - appendite nel graph di destinazione senza collision welding — se la destinazione già
    possiede un id, `n_`/`arg_` fresh mints (chain endpoints seguono la stessa mappa;
    chain key union per stile link: una chiave già asserita mantiene l'id destination);
  - coverage/checkpoint sempre in trasporto (dedupe per (chatId, fp) e checkpoint lands solo se assenti);
  - gate 409 mentre un turno o estrazione è in flight (stesso gate della cancellazione).
- Sidebar: `onMoved` trasporta i timbri scoped; helper puro `graphRevisionScopeMatches`
  in `components/graph-view.tsx` governa chi riflette su quale scope.

**Test:** `tests/workspace-move.test.ts` (23 pass) + pin dialog/sidebar estesi.

## Fase 6 — Graph view: selettore workspace (C1) — FATTA (vedi blockquote "Fase 6 fatta")

- `GET /api/graph?workspace=<id>` (assente = legacy globale, oggi il default
  — comportamento invariato per compatibilità).
- `components/graph-view.tsx`: selettore (Global (legacy) + ogni workspace +
  Unsorted non mostrato — nessun graph); la selezione persiste
  `lh:graph-workspace`.
- `graphRevision()` diventa per-workspace (max mtime dei ledger di quel
  workspace); il poll/portatore di attività trasporta l'id del workspace.
- Clusters/naming per workspace (il namer gira sul graphStore del workspace).

**Test:** estensione dei test rotte graph esistenti con il parametro
workspace.

## Fase 7 — Pulizia e verifica — FATTA (vedi blockquote "Fase 7 fatta")

- `npm test` verde (suite deterministica, no LLM, no network).
- `get_errors` pulito su tutti i file toccati.
- Nessun cambiamento ai record esistenti (assenza di `workspaceId` =
  comportamento attuale byte-per-byte per le sessioni sparse).
- Aggiornare `docs/architecture.md` (diagramma config.ts/stores) con il
  dominio workspace.

## Invarianti da rispettare (leggi del repo)

- **SILENCE LAW**: `chats-changed` solo per mutazioni di forma lista — il
  move di una sessione È una mutazione di forma (annuncia); i write di
  contenuto restano silenziosi.
- **Import law**: core non importa adapter; store non importa server.
- **Composition root unico**: nessun chiamante costruisce store — solo
  `src/server/stores.ts`.
- **Lazy versioning**: nessun file esistente viene migrato; lo stamp arriva
  al primo write.
- **Push poke, pull data**: gli eventi portano il fatto, i consumer rifetch.
- **No guessing**: se una fase rivela ambiguità non coperta da questo
  documento, STOP e domanda all'owner prima di implementare.

## Futuro riservato (non implementato ora)

- `rootPath`: workspace che apre una cartella reale già esistente con file
  già dentro (import/export bidirezionale).
- `linkedWorkspaceIds`: collegamento tra graph di workspace diversi.
- Il graph globale legacy come eventuale hub di collegamento.
