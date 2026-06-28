/**
 * Radar de réassort — boucle de monitoring des sources fiables (HTTP).
 *
 * Chaque cycle : balaie Castorama (93 mag.) + Boulanger (national) + Optimea,
 * compare les offres achetables à l'état précédent, et ALERTE sur toute NOUVELLE
 * offre (transition rupture → dispo). Aucune ré-alerte tant que l'offre persiste.
 *
 * Usage :
 *   npm run monitor                      # boucle (intervalle 4 min + jitter)
 *   npm run monitor -- --interval=3      # intervalle en minutes
 *   npm run monitor -- --once            # un seul cycle (test/cron)
 *
 * Config alertes : voir .env.example (ntfy / macOS / Telegram / webhook).
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { ALL_SCANNERS, type Offer, type ScanResult } from './sources.js';
import {
  loadAlertConfig,
  activeChannels,
  dispatchAlert,
  notifyAll,
} from './alert.js';

/** Source d'une clé d'offre (préfixe avant ':' = nom de la source). */
function sourceOfKey(key: string): string {
  const i = key.indexOf(':');
  return i === -1 ? key : key.slice(0, i);
}

// Charge .env (Node >=20.12) si présent — sinon variables d'env système.
try {
  process.loadEnvFile();
} catch {
  /* pas de .env, on continue */
}

const STATE_FILE = join(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
  '.monitor-state.json',
);

interface MonitorState {
  updatedAt: string;
  knownKeys: string[]; // offres achetables connues (pour ne pas ré-alerter)
  blind?: boolean; // true si le dernier cycle avait TOUTES les sources en panne
}

async function loadState(): Promise<MonitorState> {
  try {
    return JSON.parse(await readFile(STATE_FILE, 'utf8')) as MonitorState;
  } catch {
    return { updatedAt: '', knownKeys: [] };
  }
}

function ts(): string {
  return new Date().toLocaleString('fr-FR');
}

async function save(state: MonitorState): Promise<void> {
  await writeFile(
    STATE_FILE,
    JSON.stringify({ ...state, updatedAt: new Date().toISOString() }, null, 2),
  );
}

async function cycle(): Promise<void> {
  const cfg = loadAlertConfig();
  const results: ScanResult[] = await Promise.all(ALL_SCANNERS.map((s) => s()));

  const okResults = results.filter((r) => r.ok);
  const downSources = new Set(results.filter((r) => !r.ok).map((r) => r.source));
  const prev = await loadState();
  const known = new Set(prev.knownKeys);

  // Résumé de cycle (log de vie)
  const summary = results
    .map((r) => `${r.source}:${r.ok ? r.offers.length : 'ERR'}${r.note ? `(${r.note})` : ''}`)
    .join(' · ');

  // Radar AVEUGLE : toutes les sources en panne => ne PAS confondre avec "rupture".
  // On préserve l'état tel quel et on alerte une seule fois (transition vers aveugle).
  if (okResults.length === 0) {
    console.error(`[${ts()}] ⚠️ RADAR AVEUGLE — toutes les sources en erreur · ${summary}`);
    if (!prev.blind) {
      await notifyAll(cfg, {
        title: '⚠️ Radar aveugle - toutes les sources en erreur',
        body: 'Le radar ne peut plus lire AUCUNE source (anti-bot/API/réseau). Vérifie le radar — ce n\'est PAS une rupture.',
        tags: 'warning',
      });
    }
    await save({ knownKeys: prev.knownKeys, blind: true, updatedAt: '' });
    return;
  }

  // Offres uniquement depuis les sources SAINES (une source morte ≠ rupture).
  const offers: Offer[] = okResults.flatMap((r) => r.offers);
  const currentKeys = offers.map((o) => o.key);
  const newOffers = offers.filter((o) => !known.has(o.key));

  console.log(
    `[${ts()}] ${offers.length} offre(s) dispo · ${newOffers.length} nouvelle(s) · ${summary}`,
  );

  if (newOffers.length > 0) {
    await dispatchAlert(cfg, newOffers);
  }

  // État suivant = clés des sources saines + clés CONSERVÉES des sources en panne
  // (on n'oublie pas une offre juste parce que sa source a timeout ce cycle —
  // sinon elle re-déclencherait une fausse alerte à son retour).
  const preserved = prev.knownKeys.filter((k) => downSources.has(sourceOfKey(k)));
  const nextKeys = [...new Set([...currentKeys, ...preserved])];

  // Persiste seulement si l'ensemble change (évite le bruit de commits en cloud).
  const nextSet = new Set(nextKeys);
  const changed =
    prev.blind === true ||
    nextSet.size !== known.size ||
    [...nextSet].some((k) => !known.has(k)) ||
    [...known].some((k) => !nextSet.has(k));
  if (changed) {
    await save({ knownKeys: nextKeys, blind: false, updatedAt: '' });
  }
}

function parseInterval(argv: string[]): number {
  const a = argv.find((x) => x.startsWith('--interval='))?.slice(11);
  const min = a ? Number(a) : 4;
  return Number.isFinite(min) && min > 0 ? min : 4;
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const once = argv.includes('--once');
  const intervalMin = parseInterval(argv);
  const cfg = loadAlertConfig();

  console.log(
    `📡 Radar Midea PortaSplit — Castorama · Boulanger · Optimea · ManoMano · Dealabs · 123comparer · boutiques (MegElectro/JBS/Bruneau/Hemmera)`,
  );
  console.log(`   Canaux d'alerte actifs : ${activeChannels(cfg).join(', ')}`);

  // Test de la chaîne d'alerte (envoie une alerte factice sur tous les canaux).
  if (argv.includes('--test-alert')) {
    console.log(`   Envoi de 2 alertes de TEST (1 par destination)…`);
    await dispatchAlert(cfg, [
      {
        source: 'test',
        key: 'test-1',
        label: 'MegElectro 700€',
        url: 'https://megelectro.com/produit/midea-mmcs-12hrn8-qrd0-climatiseur-mobile/',
        price: 700,
        risky: true, // petite boutique => titre "[A VERIFIER]"
      },
      {
        source: 'test',
        key: 'test-2',
        label: 'Castorama Lyon (69003) — retrait/magasin',
        url: 'https://www.castorama.fr/climatiseur-portasplit-midea-reversible-3500w/8431312260509_CAFR.prd',
        price: 999.9,
        risky: false,
        mapsUrl:
          'https://www.google.com/maps/search/?api=1&query=' +
          encodeURIComponent('Castorama Lyon 69003'),
      },
    ]);
    console.log(`   ✅ Test envoyé. Vérifie ton téléphone / tes notifications.`);
    return;
  }
  if (!cfg.ntfyTopic && !cfg.telegramToken)
    console.log(
      `   ⚠️ Aucun canal push (téléphone) configuré — voir .env.example (NTFY_TOPIC recommandé).`,
    );

  if (once) {
    await cycle();
    return;
  }

  console.log(`   Boucle toutes les ~${intervalMin} min (Ctrl+C pour arrêter).\n`);
  for (;;) {
    try {
      await cycle();
    } catch (err) {
      console.error(`[${ts()}] Erreur de cycle :`, err);
    }
    // Intervalle + jitter ±25% pour lisser la charge / éviter les patterns.
    const jitter = (Math.random() - 0.5) * 0.5 * intervalMin;
    const waitMs = Math.max(1, intervalMin + jitter) * 60_000;
    await new Promise((r) => setTimeout(r, waitMs));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
