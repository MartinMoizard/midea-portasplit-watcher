/**
 * Client de l'API stock ManoMano (BFF GraphQL Apollo, partagé app+web).
 * Découvert par capture réseau : AUCUN Cloudflare, AUCUNE auth — juste 2 headers
 * client Apollo. Signal de stock = présence d'une offre `isSellable`
 * (avec offerOptions.acceptNonSellable:false, `offers` est vide en rupture).
 */
const ENDPOINT = 'https://graphql.manomano.fr/api/graphql';
const PRODUCT_ID = '146211357'; // id interne (l'URL /p/...-83810402 = id de page)
export const PRODUCT_URL =
  'https://www.manomano.fr/p/midea-climatiseur-split-mobile-reversible-froid-chaud-3500w12000btu-wifi-deshumidificateur-ventilateur-jusqua-40m2-kit-fenetre-inclus-83810402';

// Requête capturée verbatim (le serveur n'accepte que des opérations connues).
const QUERY =
  'query SpDetailsProductPage($platform:Platform!,$market:Market!,$productIds:[String!]!){offersByProductIds(saleChannel:{market:$market,platform:$platform} productIds:$productIds offerOptions:{acceptNonSellable:false}){offers{...ChannelOfferProduct __typename}__typename}}fragment ChannelOfferProduct on ChannelOffer{productId isSellable market variantsCount coupon{value __typename}sku{title modelId images{thumbnailUrl regularUrl largeUrl __typename}masterProduct{slug articleId brand{publicId title logo __typename}__typename}merchandisingCategory{publicId __typename}__typename}pricing{sellPrice{amountVatIncluded amountVatExcluded currency __typename}retailPrice{amountVatIncluded amountVatExcluded currency __typename}measurementSellPrice{price{currency amountVatExcluded amountVatIncluded vatPercentage __typename}unit __typename}discountPercentage __typename}commercialAnimation{tags endAt __typename}productRating{average total __typename}sellerContract{isMmf sellerContractId companyFrontName __typename}isSelectionManomano isTopSales packaging{minimumQuantity __typename}bestDeliveryPromise{price{amount __typename}__typename}__typename}';

export interface ManoManoState {
  inStock: boolean;
  price: number | null;
  seller: string | null;
}

export async function getManoManoState(timeoutMs = 25_000): Promise<ManoManoState> {
  const params = new URLSearchParams({
    query: QUERY,
    operationName: 'SpDetailsProductPage',
    variables: JSON.stringify({
      market: 'B2C',
      platform: 'FR',
      productIds: [PRODUCT_ID],
    }),
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${ENDPOINT}?${params.toString()}`, {
      headers: {
        'apollographql-client-name': 'spartacux-b2c',
        'apollographql-client-version': '1.0.0',
        Accept: 'application/json',
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`ManoMano HTTP ${res.status}`);
    const json: any = await res.json();
    // Erreur GraphQL (clé expirée, query rejetée) => ne PAS interpréter comme rupture.
    if (json?.errors && json?.data == null) {
      throw new Error(`ManoMano GraphQL: ${JSON.stringify(json.errors).slice(0, 120)}`);
    }
    const offers: any[] = json?.data?.offersByProductIds?.offers ?? [];
    const offer = offers.find((o) => o?.isSellable) ?? null;
    return {
      inStock: Boolean(offer),
      price: offer?.pricing?.sellPrice?.amountVatIncluded ?? null,
      seller: offer?.sellerContract?.companyFrontName ?? null,
    };
  } finally {
    clearTimeout(timer);
  }
}
