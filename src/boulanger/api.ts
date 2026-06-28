/**
 * Client de l'API stock Boulanger (BFF GraphQL `lastStock`).
 *
 * Découvert par capture réseau + décompilation du bundle (blg.product.js).
 * La clé `x-api-key` est une clé PUBLIQUE front (rendue dans le HTML sous
 * `clientBffApiKey`) ; Akamai ne bloque pas cet appel. Pas de cookie/OAuth.
 *
 *   POST /api/exchange/web/bcomtec/bff-frontomc-v1/graphql  (query LastStock)
 *   → results[] : magasins les plus proches AVEC stock (siteId, quantity, address)
 *   → si aucun stock nulle part : errorCode DEL_LAS_001 ("no stock anywhere")
 *
 * `lastStock` ne couvre que l'offre 1ʳᵉ-partie Boulanger (vendeur "0000"),
 * pas les offres marketplace Mirakl.
 */
import { haversineKm } from '../lib/util.js';

export const REF = '1216685';
export const PRODUCT_URL = `https://www.boulanger.com/ref/${REF}`;

// Valeurs publiques constatées (re-extraites du HTML si l'appel échoue).
const DEFAULT_API_KEY = '43f208ae-e096-4b0a-83e8-945fb8c97876';
const DEFAULT_OFFER_ID = 'f182a2a1-9317-4595-bb48-aaa09c700dc5';

const ENDPOINT =
  'https://www.boulanger.com/api/exchange/web/bcomtec/bff-frontomc-v1/graphql?cid=ls';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const LAST_STOCK_QUERY =
  'query LastStock($offerId:String!,$highPrioritySiteId:String,$deliveryAddress:DeliveriesAddressInput!){lastStock(offerId:$offerId,highPrioritySiteId:$highPrioritySiteId,deliveryAddress:$deliveryAddress){results{siteId label offerId quantity address{postalCode locality department region countryCode location{latitude longitude distance}}}}}';

export interface BoulangerStore {
  siteId: string;
  label: string;
  quantity: number;
  postalCode: string;
  city: string;
  lat: number;
  lng: number;
}

export interface OfferContext {
  apiKey: string;
  offerId: string;
  /** Dispo online 1ʳᵉ-partie lue dans la même page (attribut analytics fiable). */
  online: 'in_stock' | 'out_of_stock' | 'unknown';
}

async function fetchText(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: ctrl.signal });
    return await res.text();
  } finally {
    clearTimeout(timer);
  }
}

/** Récupère apiKey + offerId 1ʳᵉ-partie depuis la page produit (avec fallback). */
export async function getOfferContext(timeoutMs = 25_000): Promise<OfferContext> {
  try {
    const html = await fetchText(PRODUCT_URL, timeoutMs);
    const apiKey =
      html.match(/clientBffApiKey"\s*:\s*"([0-9a-f-]{16,})"/i)?.[1] ??
      DEFAULT_API_KEY;
    // offerId de l'offre vendeur "0000" (1ʳᵉ-partie), peu importe l'ordre des attributs.
    const offerId =
      html.match(
        /data-seller-id="0000"[^>]*data-offer-id="([0-9a-f-]{16,})"/i,
      )?.[1] ??
      html.match(
        /data-offer-id="([0-9a-f-]{16,})"[^>]*data-seller-id="0000"/i,
      )?.[1] ??
      DEFAULT_OFFER_ID;
    const availMatch = html.match(
      /data-analytics_product_availability="(true|false)"/i,
    );
    const online =
      availMatch == null
        ? 'unknown'
        : availMatch[1]?.toLowerCase() === 'true'
          ? 'in_stock'
          : 'out_of_stock';
    return { apiKey, offerId, online };
  } catch {
    return { apiKey: DEFAULT_API_KEY, offerId: DEFAULT_OFFER_ID, online: 'unknown' };
  }
}

type DeliveryAddress =
  | { postalCode: string; addressCountry: 'FRA' }
  | { location: { latitude: number; longitude: number } };

/** Magasins proches AVEC stock pour une adresse/point donné ([] si aucun). */
export async function lastStock(
  ctx: OfferContext,
  deliveryAddress: DeliveryAddress,
  timeoutMs = 25_000,
): Promise<BoulangerStore[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': ctx.apiKey,
        'x-ep-device-origin': 'DESKTOP',
        'User-Agent': UA,
      },
      body: JSON.stringify({
        variables: { offerId: ctx.offerId, deliveryAddress },
        query: LAST_STOCK_QUERY,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Boulanger HTTP ${res.status}`);
    const json: any = await res.json();
    // "no stock anywhere" (DEL_LAS_001) est légitime => data présent, results vide.
    // Mais une erreur d'auth/serveur (data null + errors) NE doit PAS passer pour
    // une rupture : on lève pour que la source remonte ok:false.
    const hasData = json?.data !== undefined && json?.data !== null;
    if (!hasData && (json?.faultstring || json?.errors || json?.error)) {
      throw new Error(
        `Boulanger lastStock: ${String(json.faultstring ?? JSON.stringify(json.errors ?? json.error)).slice(0, 120)}`,
      );
    }
    const results: any[] = json?.data?.lastStock?.results ?? [];
    return results
      .filter((r) => Number(r?.quantity ?? 0) > 0) // ne garder que le vrai stock
      .map((r) => ({
      siteId: String(r.siteId),
      label: String(r.label ?? r.siteId),
      quantity: Number(r.quantity ?? 0),
      postalCode: String(r.address?.postalCode ?? ''),
      city: String(r.address?.locality ?? ''),
      lat: Number(r.address?.location?.latitude),
      lng: Number(r.address?.location?.longitude),
    }));
  } finally {
    clearTimeout(timer);
  }
}

export { haversineKm };

/**
 * Maillage de la France métropolitaine (préfectures + grandes villes réparties).
 * Chaque point ramène les ~10 magasins-avec-stock les plus proches ; l'union
 * dédupliquée par siteId couvre tout le réseau qui aurait du stock.
 */
export const FRANCE_GRID: Array<{ city: string; lat: number; lng: number }> = [
  { city: 'Lille', lat: 50.6292, lng: 3.0573 },
  { city: 'Amiens', lat: 49.8941, lng: 2.2958 },
  { city: 'Le Havre', lat: 49.4944, lng: 0.1079 },
  { city: 'Rouen', lat: 49.4432, lng: 1.0999 },
  { city: 'Caen', lat: 49.1829, lng: -0.3707 },
  { city: 'Paris', lat: 48.8566, lng: 2.3522 },
  { city: 'Reims', lat: 49.2583, lng: 4.0317 },
  { city: 'Metz', lat: 49.1193, lng: 6.1757 },
  { city: 'Strasbourg', lat: 48.5734, lng: 7.7521 },
  { city: 'Nancy', lat: 48.6921, lng: 6.1844 },
  { city: 'Brest', lat: 48.3904, lng: -4.4861 },
  { city: 'Rennes', lat: 48.1173, lng: -1.6778 },
  { city: 'Nantes', lat: 47.2184, lng: -1.5536 },
  { city: 'Angers', lat: 47.4784, lng: -0.5632 },
  { city: 'Le Mans', lat: 48.0061, lng: 0.1996 },
  { city: 'Tours', lat: 47.3941, lng: 0.6848 },
  { city: 'Orléans', lat: 47.9029, lng: 1.909 },
  { city: 'Dijon', lat: 47.322, lng: 5.0415 },
  { city: 'Besançon', lat: 47.238, lng: 6.0243 },
  { city: 'Mulhouse', lat: 47.7508, lng: 7.3359 },
  { city: 'Poitiers', lat: 46.5802, lng: 0.3404 },
  { city: 'La Rochelle', lat: 46.1591, lng: -1.1521 },
  { city: 'Limoges', lat: 45.8336, lng: 1.2611 },
  { city: 'Clermont-Ferrand', lat: 45.7772, lng: 3.087 },
  { city: 'Lyon', lat: 45.764, lng: 4.8357 },
  { city: 'Saint-Étienne', lat: 45.4397, lng: 4.3872 },
  { city: 'Grenoble', lat: 45.1885, lng: 5.7245 },
  { city: 'Bordeaux', lat: 44.8378, lng: -0.5792 },
  { city: 'Bayonne', lat: 43.4929, lng: -1.4748 },
  { city: 'Pau', lat: 43.2951, lng: -0.3708 },
  { city: 'Toulouse', lat: 43.6047, lng: 1.4442 },
  { city: 'Montauban', lat: 44.0181, lng: 1.3553 },
  { city: 'Montpellier', lat: 43.6108, lng: 3.8767 },
  { city: 'Nîmes', lat: 43.8367, lng: 4.3601 },
  { city: 'Perpignan', lat: 42.6887, lng: 2.8948 },
  { city: 'Marseille', lat: 43.2965, lng: 5.3698 },
  { city: 'Avignon', lat: 43.9493, lng: 4.8055 },
  { city: 'Toulon', lat: 43.1242, lng: 5.928 },
  { city: 'Nice', lat: 43.7102, lng: 7.262 },
  { city: 'Ajaccio', lat: 41.9192, lng: 8.7386 },
  { city: 'Bastia', lat: 42.7028, lng: 9.4503 },
  { city: 'Chambéry', lat: 45.5646, lng: 5.9178 },
  { city: 'Annecy', lat: 45.8992, lng: 6.1294 },
  { city: 'Troyes', lat: 48.2973, lng: 4.0744 },
  { city: 'Bourges', lat: 47.0810, lng: 2.3987 },
];
