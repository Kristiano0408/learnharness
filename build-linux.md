# Build desktop Linux (AppImage + deb)

Guida operativa per produrre i pacchetti Linux **localmente**. Il flusso di
release vero e proprio (CI, signing, feeds di aggiornamento) è governato da
[`desktop-release.md`](desktop-release.md): qui stanno solo i passi locali.

## Prerequisiti

- Node 24 e npm dell'albero del progetto (`node --version`).
- Nessun tool aggiuntivo richiesto: `AppImage` è self-contained, il `deb`
  è installabile via `dpkg`.
- Pacchettare **su Linux**: Next traccia i binari nativi della macchina di build,
  quindi un payload costruito su macOS non è un payload Linux (regola
  "never cross-build" di `desktop-release.md`).

## La build (ordine stretto — non saltare passi)

Dalla root del repo, esegui i passi **in questo ordine**, uno dopo l'altro,
senza alcuna build intermedia in mezzo:

```sh
# 1. Gate di qualità (devono passare prima di pacchettare):
npm run typecheck && npm run lint && npm test

# 2. Build Next standalone + payload server + smoke.
#    `build-server.mjs` COPIa gli asset statici (.next/static + public/)
#    dentro .next/standalone. Se esegui `next build` DOPO quel passo,
#    la copia viene cancellata: l'AppImage gira senza CSS (layout esploso).
rm -rf dist .next/standalone
npx --no-install next build
node scripts/build-server.mjs
node scripts/smoke-provider-runtime.mjs
node scripts/smoke-server.mjs

# 3. Packaging (senza rebuild — il payload è già preparato).
npx --no-install electron-builder --linux AppImage deb
```

Output in `dist/`:

```text
dist/LearnHarness-<version>-x86_64.AppImage   (self-contained)
dist/LearnHarness-<version>-amd64.deb
dist/latest-linux.yml                          (feed updater)
dist/linux-unpacked/                           (stadio interno, ispezionabile)
```

Nota sul nome artefatto: il `${version}` viene da `package.json`. Se due
artifacts hanno versioni diverse (`ls dist/`), la build è sporca — ripedi il
passo 2 completo e ricomincia dal 3.

## Passi cosa fano

| Passo | Cosa fa | Perché |
|---|---|---|
| `rm -rf dist .next/standalone` | pulisce artefatti e payload | niente stale |
| `next build` | albero Next `output: "standalone"` | base del payload server |
| `build-server.mjs` | copia `.next/static` + `public/` nel standalone; rifiuta leak di `data/`/secrets; rimuove `dist/` root e `node_modules/electron` dal payload | **questo passo esiste perché standalone non porta gli asset statici**: senza, il server pacchettato serve HTML senza CSS/JS |
| `smoke-provider-runtime.mjs` | inizializza provider native offline, verifica moduli confinati nel payload | nessun crash runtime al boot |
| `smoke-server.mjs` | boot del server standalone (Node host; `--electron` usa il Node di Electron) + `GET /`, `/api/graph`, `/api/models`, `/api/settings` → 200 | il pacchetto servito è verificato, non solo pacchettato |
| `electron-builder --linux AppImage deb` | pacchetta l'standalone come `extraResources` dentro Electron | produce i due artefatti utente |

## Installare e runare

```sh
# AppImage (nessun root richiesto):
chmod +x dist/LearnHarness-0.3.9-x86_64.AppImage
./dist/LearnHarness-0.3.9-x86_64.AppImage

# deb:
sudo dpkg -i dist/LearnHarness-0.3.9-amd64.deb
# dipendenze mancanti? Fix con: sudo apt --fix-broken install
```

I due pacchetti condividono la stessa radice dati (l'app scrive sotto la home dell'utente, vedi config `DATA_ROOT`).

## Verificare un pacchetto rotto (debug rapido)

Il guasto più comune è il **payload senza asset statici**. Ispeziona:

```sh
# Gli asset statici ci sono nel payload?
find .next/standalone/.next/static -type f | wc -l     # valore alto, non 0
find dist/linux-unpacked/resources/server/standalone/.next/static -type f | wc -l
find dist/linux-unpacked/resources/server/standalone/.next/static -name "*.css" | head

# Il server del pacchetto serve CSS/JS? (node del payload, default :3000)
node dist/linux-unpacked/resources/server/standalone/server.js &
CSS=$(find dist/linux-unpacked/resources/server/standalone/.next/static/chunks -name "*.css" | head -1 | sed 's|.*static/|_next/static/|')
curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:3000/$CSS"   # 200 atteso, non 404
```

Se la copia static è 0, una `next build` è girata a valle di un'altra
`build-server` — riesegui il passo 2 completo. Se `next build` mostra errori,
fermati: la build va pulita prima di pacchettare.

Se la copia static è 0, una `next build` è girata a valle di un'altra
`build-server` — riesegui il passo 2 completo. Se `next build` mostra errori,
fermtiati: la build va pulita prima di pacchettare.

## Regole vincolanti (perché la build è affidabile)

1. **Ordine stretto**: `build-server` è l'ultimo `next build` prima del
   packaging. Il `next build` cancella `.next/standalone` e la copia static.
2. **Mai rebuild tra `build-server` ed `electron-builder`**.
- Gate `npm run typecheck && npm run lint && npm test` verdi prima di pacchettare;
   `smoke-server` è parte del flusso, non un extra: senza smoke, il pacchetto
   non è valido.
4. Non pacchettare mai payload sporchi (versioni artefatti diversi in `dist/`).
