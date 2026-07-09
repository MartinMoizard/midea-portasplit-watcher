# 🌡️ Midea PortaSplit — Radar de réassort

Surveille la disponibilité du climatiseur **Midea PortaSplit** (vendu sous marque
**Optimea**) chez les marchands français et **alerte sur mobile** dès qu'il
repasse en stock — où qu'il soit en France.

> Produit : split mobile réversible 3500 W / 12000 BTU — réf. Midea
> `MMCS-12HRN8-QRD0`, GTIN `8431312260509`, prix public ~999 €.

## Comment ça marche

Toutes les ~10 min, le radar interroge plusieurs sources, compare les offres
**réellement achetables** à l'état précédent, et envoie **une notification par
destination** (clic direct) sur toute **nouvelle** dispo. Pas de ré-alerte tant
qu'une offre persiste ; ré-alerte si elle disparaît puis revient.

Il tourne **gratuitement dans le cloud** (GitHub Actions), **sans PC allumé**.

### Sources surveillées

| Source | Couvre | Méthode | Fiabilité |
| --- | --- | --- | --- |
| **Castorama** | 93 magasins + livraison | API Kingfisher + BFF (stock réel) | 🟢 direct |
| **Boulanger** | tous magasins + livraison | API GraphQL `lastStock` | 🟢 direct |
| **Optimea** (officiel) | neuf + seconde vie | API Store WooCommerce (503=épuisé) | 🟢 direct |
| **ManoMano** | offre Optimea | API GraphQL (sans anti-bot) | 🟢 direct |
| **Boutiques** | MegElectro, JBS, Bruneau, Hemmera | WooCommerce/Shopify/JSON-LD | 🟡 vendeur à vérifier |
| **123comparer** | Darty, Fnac, Carrefour, Auchan, Amazon, Cdiscount | comparateur (indirect) | 🟡 agrégé |
| **Dealabs** | n'importe quel marchand | signal communautaire | 🟡 communautaire |

Détail des API découvertes (recettes par enseigne, sites écartés, sites bloqués
nécessitant un proxy) : **[docs/api-notes.md](docs/api-notes.md)**.

## Alertes

- **ntfy.sh** (push mobile, gratuit) — recommandé · **macOS** · **Telegram** · **webhook**.
- **1 notif = 1 destination**, avec clic direct. Pour un magasin : la **ville est
  dans le titre**, un **lien Maps** pointe le magasin, + rappel de bien le sélectionner.
- Vendeur peu connu → titre **`⚠️ [A VERIFIER]`** (+ tag ntfy `warning`).
- Si **toutes** les sources tombent en panne, une alerte « radar aveugle » est
  envoyée (ne pas confondre panne et rupture).

Config : copier `.env.example` → `.env` (voir [.env.example](.env.example)).

## Lancer

```bash
npm install
cp .env.example .env                 # configurer NTFY_TOPIC (push mobile)
npm run monitor -- --test-alert      # vérifier que les alertes arrivent
npm run monitor                      # boucle locale (~4 min + jitter)
npm run monitor -- --once            # un seul cycle (utilisé par le cron cloud)
```

Sweeps exhaustifs à la demande (toute la France, magasin par magasin) :

```bash
npm run casto:stock        # 93 magasins Castorama
npm run boulanger:stock    # réseau Boulanger national
```

## Déploiement cloud (gratuit, sans PC)

GitHub Actions exécute `npm run monitor -- --once` via cron — repo **public** =
minutes **illimitées gratuites**. Workflow : [.github/workflows/radar.yml](.github/workflows/radar.yml).

- Cron : `4,14,24,34,44,54 * * * *` (minutes décalées : les crons GitHub sont
  *best-effort* et sautés aux heures rondes ; décaler améliore la fiabilité).
- Le topic ntfy est un **secret GitHub** `NTFY_TOPIC` (pas dans le code) —
  plusieurs topics possibles séparés par des virgules (`topic1,topic2`). Autres
  secrets possibles : `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `WEBHOOK_URL`.
- Anti-spam : `.monitor-state.json` est versionné (committé par le bot), push
  robuste avec rebase+retry.

> ⚠️ Le scheduler GitHub est *best-effort* (retards/sauts possibles). Pour une
> cadence garantie : pinger externe (cron-job.org) ou exécution locale
> `caffeinate -is npm run monitor`.

## Architecture

```
src/
  types.ts            # type Availability
  lib/
    http.ts           # fetch headers navigateur + détection anti-bot
    jsonld.ts         # extraction JSON-LD + offers.availability
    availability.ts   # normalisation schema.org + heuristique texte
    util.ts           # haversine, pool concurrence, retry, PRICE_MAX
  casto/      api.ts (Kingfisher/Castorama) · sweep.ts (npm run casto:stock)
  boulanger/  api.ts (GraphQL lastStock)     · sweep.ts (npm run boulanger:stock)
  manomano/   api.ts (GraphQL)
  optimea/    api.ts (WooCommerce Store API)
  monitor/
    sources.ts        # collecteurs d'offres (1 scanner par source) + ALL_SCANNERS
    shops.ts          # boutiques génériques (WooCommerce/Shopify/JSON-LD)
    alert.ts          # dispatch multi-canal (ntfy/macOS/Telegram/webhook)
    index.ts          # boucle, détection de transition, persistance d'état
scripts/capture.mjs   # capture réseau Playwright (re-découvrir un endpoint)
docs/api-notes.md     # recettes API par enseigne
```

**Ajouter une source** : un scanner dans `src/monitor/sources.ts` (ajouté à
`ALL_SCANNERS`), ou une boutique dans le tableau `SHOPS` de `src/monitor/shops.ts`.

## Éthique & bonnes pratiques

- Cadence raisonnable (~10 min) + jitter, jamais de martèlement.
- Usage personnel (suivi d'un achat). Filtre prix ≤ 1100 € pour écarter les
  revendeurs opportunistes ; vendeurs peu connus signalés à vérifier.
