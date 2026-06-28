/** Statut de disponibilité normalisé, indépendant de l'enseigne. */
export type Availability =
  | 'in_stock' // achetable, livraison/retrait possible
  | 'limited' // dispo mais stock annoncé limité
  | 'preorder' // précommande / réappro annoncé
  | 'out_of_stock' // rupture
  | 'unknown' // page atteinte mais statut illisible
  | 'blocked' // bloqué par anti-bot (DataDome/Cloudflare/Akamai...)
  | 'not_found' // produit absent / page 404
  | 'error'; // erreur réseau / technique
