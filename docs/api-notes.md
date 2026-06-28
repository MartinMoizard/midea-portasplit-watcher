# Recettes API découvertes (reverse-engineering)

Synthèse des endpoints de stock réels craqués par enseigne. Sert de référence
pour maintenir/étendre les adapters. Produit : Midea PortaSplit / Optimea,
GTIN `8431312260509`, réf Midea `MMCS-12HRN8-QRD0`, Amazon ASIN `B0CY2YW8BT`.

> Rappel : le `availability:"InStock"` du JSON-LD signifie « produit référencé »,
> pas « en stock ». Toujours confirmer avec le vrai signal de stock.

---

## ✅ Castorama (groupe Kingfisher) — INTÉGRÉ, sans auth

Le plus propre. Voir `src/casto/api.ts`.

```
# Liste de TOUS les magasins (un appel, centre France)
GET https://api.kingfisher.com/v1/mobile/stores/CAFR?nearLatLong=46.6,2.5&page[size]=500
Header: Authorization: Atmosphere atmosphere_app_id=kingfisher-o4ITR0sWAyCVQBraQf4Es61jHV3dN4oO9UwJQMrS

# Stock réel par magasin + livraison (BFF castorama.fr, AUCUNE auth)
GET https://www.castorama.fr/casto-browse-mfe/api/fulfilment-options?compositeOfferId=8431312260509&storeId=<id>&postalCode=<cp>
→ data[0].attributes.{homeDelivery,clickAndCollectStorePick,inStore}.{availability,quantity}
```
`compositeOfferId` = l'EAN. 93 magasins réels après filtrage.

---

## ✅ Boulanger — INTÉGRÉ, sans auth (HTTP)

Stock PAR MAGASIN via GraphQL `lastStock` sur le BFF. Voir `src/boulanger/api.ts`.

```
POST https://www.boulanger.com/api/exchange/web/bcomtec/bff-frontomc-v1/graphql?cid=ls
Headers: content-type: application/json
         x-api-key: 43f208ae-e096-4b0a-83e8-945fb8c97876   (clé PUBLIQUE front = clientBffApiKey du HTML)
         x-ep-device-origin: DESKTOP
Body: { variables:{ offerId, deliveryAddress:{postalCode,addressCountry:"FRA"} | {location:{latitude,longitude}} }, query: "query LastStock…" }
→ data.lastStock.results[] : { siteId, label, quantity, address{postalCode,locality,location{latitude,longitude,distance}} }
→ aucun stock nulle part : errorCode DEL_LAS_001 "no stock for this product anywhere"
```
- `offerId` 1ʳᵉ-partie (vendeur "0000") : `f182a2a1-9317-4595-bb48-aaa09c700dc5`, lu dans
  le HTML (`data-seller-id="0000"` + `data-offer-id`). `lastStock` = stock physique
  Boulanger uniquement (pas marketplace Mirakl).
- Renvoie les 10 magasins-avec-stock les plus proches → boucler sur un maillage de
  villes pour couvrir la France (`npm run boulanger:stock`).
- Online 1ʳᵉ-partie : attribut `data-analytics_product_availability="true|false"` du HTML.

## ✅ Optimea (officiel, WooCommerce) — INTÉGRÉ, sans auth

Voir `src/retailers/optimea.ts`.

```
GET https://www.optimea.fr/wp-json/wc/store/v1/products?slug=climatiseur-split-mobile-midea
GET https://www.optimea.fr/wp-json/wc/store/v1/products?slug=seconde-vie-climatiseur-split-mobile-midea-silencieux-reversible-sans-installation
→ [0].is_in_stock (bool), is_purchasable, prices.price (minor units)
```
État 2026-06-28 : site entier en **HTTP 503 (maintenance, stock épuisé)**.
**Signal de restock = passage 503 → 200.**

---

## ✅ Amazon.fr — INTÉGRÉ, navigateur

Voir `src/retailers/amazon.ts`. GET HTTP insuffisant (#availability en JS).
Headless DOM OK aujourd'hui (0 CAPTCHA), mais polling continu → proxy résidentiel
ou PA-API.

- Achetable = `#add-to-cart-button` présent **ET** prix buybox non-null.
- Prix : `#corePriceDisplay_desktop_feature_div .a-offscreen` (⚠️ scoper au buybox,
  sinon on lit un produit du carrousel « similaires »).
- Dispo : `#availability span` · Vendeur : `#merchantInfoFeature_feature_div`.
- ASIN : B0CY2YW8BT (principal), B0D3PP64JS, B0F1531BBX, B0GXDWTFR5, B09X5RTZBT.
- Voie officielle stable : **PA-API v5** (`Offers.Listings.Availability`), nécessite
  un compte Affiliés actif.

---

## ✅ ManoMano — COUVERT (adapter navigateur générique)

Cloudflare passé en headless stealth (pas de Turnstile rencontré). Pas d'endpoint
JSON de stock dédié : le stock est server-side dans le HTML.
- Source : JSON-LD `Offer.availability` + bouton panier `disabled`.
- Vendeur : **OPTIMEA** (marchand officiel, `/marchand-39993745`).
- `productId` interne = `146211357` (l'id 83810402 de l'URL = id de page).

---

## ⚠️ Leroy Merlin / groupe Adeo (Weldom, Bricoman) — À FINIR (proxy requis)

DataDome bloque totalement le front depuis une IP datacenter (IP de sortie
blacklistée pendant la recon). Architecture API reconstituée (plateforme « Square »
Adeo, commune à tous les pays) :

```
Auth : header  x-square-api-key: <clé statique front>
Base FR : api.leroymerlin.fr  (Fastly+Kong, PAS derrière DataDome)

Stock tous magasins : fulfillment-services/v1/allStoreStock/{productCode}
Stock 1 magasin     : .../stock/{storeCode}/{productCode}
Stock temps réel    : realtime-stock/v1/realtime-digitalstock?storeCodes=…&productCodes=…
Liste magasins      : store/1_0_0/activestore/list/{spaceId}        → .content
Magasins par GPS    : store/1_0_0/search/coords/{spaceId}/{lat}/{lng}?orderBy=distance
```
Source du mapping : npm `@byte-code/lm-remote-api`. **Manque** : noms de routes FR
exacts + `spaceId` + `x-square-api-key` FR → à capturer en chargeant la fiche
depuis une **IP résidentielle FR** (clic sélecteur magasin → XHR vers
api.leroymerlin.fr). Une fois la clé obtenue, le balayage France est scriptable
en masse (le gateway API n'a pas de DataDome).

---

## ⚠️ Mr.Bricolage — CRACKÉ mais nécessite un vrai Chrome (non-headless)

Magento + store-locator Leadformance derrière Cloudflare. Les pages HTML passent
en headless, mais les endpoints REST renvoient 403 en headless → il faut
**Playwright `channel:'chrome'` + `headless:false`** (vrai Chrome, fingerprint OK),
puis appeler via le jQuery de la page. Pas de proxy requis. Donc non intégrable
dans le radar HTTP always-on (besoin d'un Chrome avec affichage).

```
# Stock (par magasin si slug, sinon national)
GET https://www.mr-bricolage.fr/{store-slug}/rest/V1/product/getproduct/product_id/168476
    Headers: X-Requested-With: XMLHttpRequest, Accept: application/json
    → saleable (bool), product_data.{stock,availability,price}
# Liste magasins (lat,lng → ~36/point)
POST https://www.mr-bricolage.fr/{slug}/storelocator/api/geosearch/   body: geo=48.8566, 2.3522
    → rows[].{name, localisation{postalCode,city,latitude,longitude}, externalAttributes.locationId}
```
`product_id` Magento = `168476` (≠ EAN). 28/06/2026 : 189 magasins scannés,
**100% rupture** (`saleable:false`, `OutOfStock`). Script : `/tmp/mrb_scan2.mjs`.

## ⚠️ Fnac & Darty — BLOQUÉ (DataDome, proxy + CAPTCHA requis)

Fnac et Darty partagent le **même compte DataDome** (challenge dur `t:'fe'`). Headless
stealth bloqué dès la homepage ; aucun snapshot Wayback n'existe. Recette Darty
extraite du bundle `product.bundle.js` (assets statiques non gatés) — exploitable
seulement avec un cookie `datadome` valide (proxy résidentiel FR + solveur CAPTCHA,
ou résolution manuelle one-shot) :

```
# Stock par magasin (retrait / Click&Collect) — renvoie du HTML <div class="store" data-code=…>
GET https://www.darty.com/nav/extra/ajax/click_and_collect?codic={CODIC}&zipCode={CP}
# Livraison (JSON {status:true|false,...})
GET https://www.darty.com/nav/extra/ajax/product_warehouse?codic={CODIC}&zipCode={CP}&insee={INSEE}&cityName={VILLE}
# GPS→CP/INSEE : /nav/extra/ajax/gps_insee?latitude=..&longitude=..
```
`codic` Darty = `data-codic` sur la fiche rendue (non obtenu, page jamais chargée).
Réf Fnac (prid) = `21457105`. Endpoints Fnac non récupérés (bundle derrière le challenge).

Signal externe : produit **volatil** — « de nouveau en stock » chez Darty ~24-26/06/2026
puis re-rupture le 26/06. Les réappros existent → alerting pertinent.

## ❌ Auchan — DÉRÉFÉRENCÉ

Produit retiré du catalogue : fragment `/product-page` renvoie
`data-current-seller-type="NONE"`, `data-handled-seller-types="[]"`, message
**« Ce produit n'est plus dans notre gamme »**, GTIN absent. Retiré du registre.

Pour mémoire (si re-listé un jour), la lecture du stock Auchan est complexe (SPA) :
`GET /geocoding/autocomplete` → `GET /offering-contexts` → `POST /journey/update`
(seller.id + channel + storeReference) → `GET /product-page?productId=…`
(header `x-requested-with`, cookie journey). Lire `data-handled-seller-types`
(vendeurs dispo) + prix dans `.offer-selector__components-wrapper`.

## ✅ Boutiques spécialisées — INTÉGRÉES (checkers génériques)

`src/monitor/shops.ts` — WooCommerce Store API / Shopify `.js` / JSON-LD, filtre
prix ≤ 1100€, flag `risky` (titre d'alerte "[A VERIFIER]") pour petits vendeurs :
- **MegElectro** (WooCommerce, `is_in_stock`) — 700€, EN STOCK le 28/06/2026. SIREN/SIRET OK.
- **JBS Électroménager** (Shopify, `variants[].available`) — 849,99€, EN STOCK. RCS OK.
- **Bruneau** (B2B, JSON-LD) — 999€, rupture. **Hemmera** (JSON-LD) — rupture.

## ⚠️ Carrefour — DÉLISTÉ / Weldom — ABSENT

- **Carrefour** : Cloudflare (Playwright Chromium passe). Fiche
  `carrefour.fr/p/midea-portasplit-...-8431312260509` mais **offerCount 0, « a
  déserté les rayons »** → délisté. Couvert indirectement via 123comparer.
- **Weldom** (Adeo) : **produit non référencé**. N'est PAS sur la plateforme Square
  d'Adeo (Magento + Sensefuel, DataDome, vrai Chrome requis). Marque maison
  « OPTIMEO » ≠ « Optimea ». Rien à surveiller.

## ❌ eBay / Rakuten — hors cloud

eBay : annonces neuves ~788-830€ vues, mais scraping bloqué depuis IP datacenter →
**API Browse officielle** requise (compte dev gratuit, OAuth client_credentials,
filtre `price:[..1100]`). Rakuten : 403 + page freeze sur IP datacenter, pas d'API
acheteur → **proxy résidentiel** requis. Tous deux suivis indirectement (leDénicheur
tracke eBay/Rakuten/Boulanger ; 123comparer tracke aussi).

## ❌ Cdiscount — PAS DE FICHE

Aucune fiche officielle Midea PortaSplit/Optimea (GTIN + marque vérifiés).
Seul un faux listing « ROLIPO » à 2999€ (mauvaise marque/catégorie) — à ignorer.
Pour mémoire, endpoint dispo Cdiscount si un jour référencé :
`https://bffmobilesite.cdiscount.com/product-sheets/offer-shipping-information`.
