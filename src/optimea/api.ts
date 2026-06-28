/**
 * Client Optimea — distributeur OFFICIEL (optimea.fr, WooCommerce).
 *
 * Lecture du stock via l'API Store WooCommerce (JSON public, HTTP simple) :
 *   GET /wp-json/wc/store/v1/products?slug=<slug>  ->  is_in_stock, prices.price
 *
 * Au 2026-06-28 : tout le site est en MAINTENANCE (HTTP 503) car le stock de
 * clims a été entièrement vendu. Le retour en HTTP 200 = signal de restock.
 * On surveille les 2 fiches : neuf + seconde vie (reconditionné ~799€).
 */
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

const VARIANTS = [
  { label: 'neuf', slug: 'climatiseur-split-mobile-midea' },
  {
    label: 'seconde vie',
    slug: 'seconde-vie-climatiseur-split-mobile-midea-silencieux-reversible-sans-installation',
  },
];

export const OPTIMEA_URL =
  'https://www.optimea.fr/product/climatiseur-split-mobile-midea/';

export interface VariantState {
  label: string;
  inStock: boolean;
  price: number | null;
  maintenance: boolean;
}

/** Vérifie les 2 variantes (neuf + seconde vie) via l'API Store WooCommerce. */
export async function checkOptimeaVariants(
  timeoutMs = 25_000,
): Promise<VariantState[]> {
  return Promise.all(VARIANTS.map((v) => checkVariant(v.slug, v.label, timeoutMs)));
}

async function checkVariant(
  slug: string,
  label: string,
  timeoutMs: number,
): Promise<VariantState> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(
      `https://www.optimea.fr/wp-json/wc/store/v1/products?slug=${slug}`,
      {
        headers: { 'User-Agent': UA, Accept: 'application/json' },
        signal: ctrl.signal,
      },
    );
    const ct = res.headers.get('content-type') ?? '';
    // 503 ou réponse non-JSON => boutique en maintenance (stock épuisé).
    if (res.status === 503 || !ct.includes('json')) {
      return { label, inStock: false, price: null, maintenance: true };
    }
    const arr = (await res.json()) as any[];
    const p = Array.isArray(arr) ? arr[0] : null;
    if (!p) return { label, inStock: false, price: null, maintenance: false };
    const minor = p.prices?.currency_minor_unit ?? 2;
    const raw = p.prices?.price;
    const n =
      raw != null && Number.isFinite(Number(raw)) ? Number(raw) / 10 ** minor : 0;
    return {
      label,
      inStock: Boolean(p.is_in_stock && p.is_purchasable),
      price: n > 0 ? n : null, // 0 = placeholder => null
      maintenance: false,
    };
  } finally {
    clearTimeout(timer);
  }
}
