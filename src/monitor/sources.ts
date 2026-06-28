/**
 * Collecteurs d'offres ACHETABLES par source fiable (HTTP, sans navigateur).
 * Chaque scanner renvoie la liste des offres en stock *maintenant*, avec une
 * clé stable (`key`) par offre (canal/magasin) pour détecter les transitions.
 */
import {
  fetchAllStores,
  fulfilment,
  buyable as castoBuyable,
  PRODUCT_URL as CASTO_URL,
} from '../casto/api.js';
import {
  getOfferContext,
  lastStock,
  FRANCE_GRID,
  PRODUCT_URL as BOULANGER_URL,
} from '../boulanger/api.js';
import { checkOptimeaVariants, OPTIMEA_URL } from '../retailers/optimea.js';
import { getManoManoState, PRODUCT_URL as MANOMANO_URL } from '../manomano/api.js';
import { fetchHtml } from '../lib/http.js';
import { pool, withRetry } from '../lib/util.js';
import { scanShops } from './shops.js';

export interface Offer {
  source: string; // 'castorama' | 'boulanger' | 'optimea'
  key: string; // identifiant stable de l'offre (dédup + transition)
  label: string; // texte lisible pour l'alerte
  url: string;
  price: number | null;
  /** Vendeur peu connu / signal à confirmer => avertissement DANS le titre. */
  risky?: boolean;
  /** Lien Google Maps vers le magasin précis (offres en magasin). */
  mapsUrl?: string;
}

/** Lien Maps vers un magasin précis (1 tap = itinéraire vers la ville). */
function mapsLink(enseigne: string, city: string, postalCode: string): string {
  const q = encodeURIComponent(`${enseigne} ${city} ${postalCode}`.trim());
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export interface ScanResult {
  source: string;
  offers: Offer[];
  ok: boolean;
  note?: string;
}

/** Castorama : 93 magasins + livraison. */
export async function scanCastorama(): Promise<ScanResult> {
  try {
    const stores = await withRetry(() => fetchAllStores());
    const rows = await pool(stores, 8, (s) =>
      withRetry(() => fulfilment(s.id, s.postalCode))
        .then((f) => ({ s, f }))
        .catch(() => ({ s, f: null as any })),
    );
    const offers: Offer[] = [];
    let deliveryDone = false;
    for (const { s, f } of rows) {
      if (!f) continue;
      if (!deliveryDone && castoBuyable(f.homeDelivery)) {
        deliveryDone = true;
        offers.push({
          source: 'castorama',
          key: 'castorama:delivery',
          label: 'Castorama — livraison à domicile',
          url: CASTO_URL,
          price: 999.9,
        });
      }
      if (castoBuyable(f.inStore) || castoBuyable(f.clickAndCollect)) {
        offers.push({
          source: 'castorama',
          key: `castorama:store:${s.id}`,
          label: `Castorama ${s.city} (${s.postalCode}) — retrait/magasin`,
          url: CASTO_URL,
          price: 999.9,
          mapsUrl: mapsLink('Castorama', s.city, s.postalCode),
        });
      }
    }
    return { source: 'castorama', offers, ok: true };
  } catch (err) {
    return {
      source: 'castorama',
      offers: [],
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Boulanger : magasins (lastStock sur maillage France) + livraison online. */
export async function scanBoulanger(): Promise<ScanResult> {
  try {
    const offer = await withRetry(() => getOfferContext());
    const offers: Offer[] = [];
    if (offer.online === 'in_stock') {
      offers.push({
        source: 'boulanger',
        key: 'boulanger:online',
        label: 'Boulanger — livraison à domicile',
        url: BOULANGER_URL,
        price: 999,
      });
    }
    const lists = await pool(FRANCE_GRID, 6, (pt) =>
      withRetry(() =>
        lastStock(offer, { location: { latitude: pt.lat, longitude: pt.lng } }),
      ).catch(() => []),
    );
    const seen = new Set<string>();
    for (const list of lists)
      for (const s of list) {
        if (s.quantity > 0 && !seen.has(s.siteId)) {
          seen.add(s.siteId);
          offers.push({
            source: 'boulanger',
            key: `boulanger:store:${s.siteId}`,
            label: `Boulanger ${s.city} (${s.postalCode}) — ${s.quantity} en stock`,
            url: BOULANGER_URL,
            price: 999,
            mapsUrl: mapsLink('Boulanger', s.city, s.postalCode),
          });
        }
      }
    return { source: 'boulanger', offers, ok: true };
  } catch (err) {
    return {
      source: 'boulanger',
      offers: [],
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/** Optimea (officiel) : neuf + seconde vie via API Store WooCommerce. */
export async function scanOptimea(): Promise<ScanResult> {
  try {
    const states = await checkOptimeaVariants();
    const offers: Offer[] = states
      .filter((s) => s.inStock)
      .map((s) => ({
        source: 'optimea',
        key: `optimea:${s.label}`,
        label: `Optimea (officiel) — ${s.label}${s.price ? ` ${s.price}€` : ''}`,
        url: OPTIMEA_URL,
        price: s.price,
      }));
    const allMaintenance = states.every((s) => s.maintenance);
    return {
      source: 'optimea',
      offers,
      ok: true,
      note: allMaintenance ? 'maintenance (503)' : undefined,
    };
  } catch (err) {
    return {
      source: 'optimea',
      offers: [],
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Dealabs : signal COMMUNAUTAIRE (couvre indirectement TOUTES les enseignes,
 * même celles bloquées par DataDome — un humain poste le restock). On surveille
 * la recherche filtrée sur les deals NON expirés : tout deal actif = réassort.
 */
const DEALABS_URL =
  'https://www.dealabs.com/search?q=portasplit&hide_expired=true&sort_by=new';

export async function scanDealabs(): Promise<ScanResult> {
  try {
    const res = await fetchHtml(DEALABS_URL, 25_000);
    if (res.blocked) {
      return { source: 'dealabs', offers: [], ok: false, note: 'bloqué (Cloudflare)' };
    }
    const offers: Offer[] = [];
    const seen = new Set<string>();
    // Découpe par item de thread ; on ignore les deals expirés.
    for (const chunk of res.html.split(/cept-thread-item/)) {
      if (/thread--expired/.test(chunk)) continue;
      const link = chunk.match(
        /href="(https:\/\/www\.dealabs\.com\/bons-plans\/[^"]*?-(\d+))"/,
      );
      if (!link) continue;
      const url = link[1]!;
      const id = link[2]!;
      if (seen.has(id)) continue;
      const titleMatch = chunk.match(/title="([^"]{6,200})"/);
      const title = titleMatch ? titleMatch[1]!.replace(/&[a-z]+;/g, ' ').trim() : 'deal actif';
      // La page de recherche affiche aussi des deals "populaires" hors sujet :
      // on ne garde QUE ceux qui mentionnent vraiment le produit.
      if (!/portasplit/i.test(url) && !/portasplit/i.test(title)) continue;
      seen.add(id);
      offers.push({
        source: 'dealabs',
        key: `dealabs:${id}`,
        label: `Dealabs : ${title}`,
        url,
        price: null,
      });
    }
    return { source: 'dealabs', offers, ok: true };
  } catch (err) {
    return {
      source: 'dealabs',
      offers: [],
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/** ManoMano : API GraphQL (HTTP, sans anti-bot). Vendeur = Optimea officiel. */
export async function scanManoMano(): Promise<ScanResult> {
  try {
    const s = await withRetry(() => getManoManoState());
    const offers: Offer[] = s.inStock
      ? [
          {
            source: 'manomano',
            key: 'manomano:offer',
            label: `ManoMano${s.seller ? ` (${s.seller})` : ''}${s.price ? ` — ${s.price}€` : ''}`,
            url: MANOMANO_URL,
            price: s.price,
          },
        ]
      : [];
    return { source: 'manomano', offers, ok: true };
  } catch (err) {
    return {
      source: 'manomano',
      offers: [],
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * 123comparer.fr : comparateur SANS anti-bot qui agrège la dispo par marchand.
 * Sert de radar pour les enseignes qu'on ne peut PAS interroger en direct
 * (Darty, Fnac, Carrefour... bloquées par DataDome). Règle conservatrice :
 * un marchand est "dispo" s'il est présent ET PAS dans la section historique
 * "C'était disponible chez… / N'est plus disponible depuis". Castorama,
 * Boulanger, ManoMano sont exclus (couverts en direct, plus fiable).
 */
const COMPARER_URL =
  'https://www.123comparer.fr/climatiseurs-mobiles/8y4dgcjugr3drptogwad1.html';
const COMPARER_TARGETS = ['Darty', 'Fnac', 'Carrefour', 'Auchan', 'Amazon', 'Cdiscount'];

export async function scanComparer(): Promise<ScanResult> {
  try {
    const res = await fetchHtml(COMPARER_URL, 25_000);
    if (res.blocked) {
      return { source: 'comparer', offers: [], ok: false, note: 'bloqué' };
    }
    const idx = res.html.indexOf("C'était disponible");
    if (idx === -1) {
      // structure inattendue : on n'émet rien plutôt que de risquer un faux positif
      return { source: 'comparer', offers: [], ok: false, note: 'structure changée' };
    }
    const historical = res.html.slice(idx);
    const offers: Offer[] = COMPARER_TARGETS.filter(
      (m) => res.html.includes(m) && !historical.includes(m),
    ).map((m) => ({
      source: 'comparer',
      key: `comparer:${m.toLowerCase()}`,
      label: `${m} (vu dispo sur 123comparer)`,
      url: COMPARER_URL,
      price: null,
    }));
    return { source: 'comparer', offers, ok: true };
  } catch (err) {
    return {
      source: 'comparer',
      offers: [],
      ok: false,
      note: err instanceof Error ? err.message : String(err),
    };
  }
}

export const ALL_SCANNERS = [
  scanCastorama,
  scanBoulanger,
  scanOptimea,
  scanManoMano,
  scanDealabs,
  scanComparer,
  scanShops,
];
