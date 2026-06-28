/**
 * Boutiques spécialisées (petits e-commerçants) interrogées via des checkers
 * GÉNÉRIQUES par plateforme — facile d'en ajouter d'autres.
 *   - woocommerce : API Store /wp-json/wc/store/v1/products (is_in_stock réel)
 *   - shopify     : <url>.js (variants[].available = inventaire réel)
 *   - jsonld      : JSON-LD offers.availability (fallback)
 *
 * Filtre prix : on ignore les offres > PRICE_MAX (revendeurs opportunistes).
 * Les petites boutiques sont marquées "vérifier le vendeur" dans l'alerte.
 */
import type { Offer, ScanResult } from './sources.js';
import { fetchHtml } from '../lib/http.js';
import { extractJsonLd, findProductOffer } from '../lib/jsonld.js';
import { pool, PRICE_MAX } from '../lib/util.js';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

type Kind = 'woocommerce' | 'shopify' | 'jsonld';

interface Shop {
  id: string;
  name: string;
  kind: Kind;
  url: string; // page produit (lien d'achat)
  base?: string; // racine du site (woocommerce)
  search?: string; // terme de recherche Store API (woocommerce)
  verify?: boolean; // petite boutique => caveat "vérifier le vendeur"
}

const SHOPS: Shop[] = [
  {
    id: 'megelectro',
    name: 'MegElectro',
    kind: 'woocommerce',
    base: 'https://megelectro.com',
    search: 'MMCS-12HRN8',
    url: 'https://megelectro.com/produit/midea-mmcs-12hrn8-qrd0-climatiseur-mobile/',
    verify: true,
  },
  {
    id: 'jbs',
    name: 'JBS Électroménager',
    kind: 'shopify',
    url: 'https://jbs-electromenager.com/products/climatiseur-mobile-midea-mmcs-12hrn8-qrd0',
    verify: true,
  },
  {
    id: 'bruneau',
    name: 'Bruneau',
    kind: 'jsonld',
    url: 'https://www.bruneau.fr/product/climatiseur-mobile-midea-mmcs-12hrn8-qrd0/8497277',
  },
  {
    id: 'hemmera',
    name: 'Hemmera',
    kind: 'jsonld',
    url: 'https://www.hemmera.fr/climatiseur-portable-midea-mmcs-12hrn8-3-5-kw.-pompe-a-chaleur-r32-kit-inclus/',
    verify: true,
  },
];

interface ShopState {
  inStock: boolean;
  price: number | null;
}

async function getJson(url: string, timeoutMs: number): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function checkWoo(shop: Shop, timeoutMs: number): Promise<ShopState> {
  const arr = await getJson(
    `${shop.base}/wp-json/wc/store/v1/products?search=${encodeURIComponent(shop.search ?? '')}`,
    timeoutMs,
  );
  const list: any[] = Array.isArray(arr) ? arr : [];
  const p =
    list.find((x) => /mmcs-12hrn8|portasplit/i.test(`${x.name} ${x.sku}`)) ??
    list[0];
  if (!p) return { inStock: false, price: null };
  const minor = p.prices?.currency_minor_unit ?? 2;
  const raw = p.prices?.price != null ? Number(p.prices.price) / 10 ** minor : 0;
  const price = raw > 0 ? raw : null; // 0 = placeholder/prix mal lu => null
  return { inStock: Boolean(p.is_in_stock && p.is_purchasable), price };
}

async function checkShopify(shop: Shop, timeoutMs: number): Promise<ShopState> {
  const p = await getJson(`${shop.url}.js`, timeoutMs);
  const rawPrice = p?.price != null ? Number(p.price) / 100 : 0;
  const price = rawPrice > 0 ? rawPrice : null;
  const available =
    Boolean(p?.available) ||
    (Array.isArray(p?.variants) && p.variants.some((v: any) => v?.available));
  return { inStock: available, price };
}

async function checkJsonLd(shop: Shop, timeoutMs: number): Promise<ShopState> {
  const res = await fetchHtml(shop.url, timeoutMs);
  if (res.blocked) throw new Error('bloqué');
  const offer = findProductOffer(extractJsonLd(res.html));
  return {
    inStock: offer?.status === 'in_stock' || offer?.status === 'limited',
    price: offer?.price ?? null,
  };
}

async function checkShop(shop: Shop, timeoutMs: number): Promise<ShopState> {
  if (shop.kind === 'woocommerce') return checkWoo(shop, timeoutMs);
  if (shop.kind === 'shopify') return checkShopify(shop, timeoutMs);
  return checkJsonLd(shop, timeoutMs);
}

export async function scanShops(): Promise<ScanResult> {
  const results = await pool(SHOPS, 4, async (shop) => {
    try {
      const s = await checkShop(shop, 20_000);
      return { shop, state: s, err: null as string | null };
    } catch (err) {
      return {
        shop,
        state: null,
        err: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const offers: Offer[] = [];
  let errors = 0;
  for (const r of results) {
    if (!r.state) {
      errors++;
      continue;
    }
    const { inStock, price } = r.state;
    // filtre prix : on ignore les offres trop chères (revendeurs)
    if (inStock && (price == null || price <= PRICE_MAX)) {
      offers.push({
        source: 'shops',
        key: `shops:${r.shop.id}`,
        label: `${r.shop.name}${price ? ` — ${price}€` : ''}`,
        url: r.shop.url,
        price,
        risky: r.shop.verify, // petite boutique => avertissement dans le titre
      });
    }
  }
  return {
    source: 'shops',
    offers,
    ok: errors < SHOPS.length,
    note: errors ? `${errors}/${SHOPS.length} boutique(s) en erreur` : undefined,
  };
}
