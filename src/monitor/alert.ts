/**
 * Dispatcher d'alertes multi-canal. Configuré par variables d'environnement
 * (cf. .env.example). Chaque canal échoue indépendamment (jamais bloquant).
 *
 *   ntfy.sh        -> push téléphone, zéro compte (NTFY_TOPIC, plusieurs
 *                     topics possibles séparés par des virgules)
 *   macOS          -> notification + son (ALERT_MACOS=1, défaut sur darwin)
 *   Telegram       -> TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID
 *   Webhook        -> WEBHOOK_URL (POST JSON, ex. Slack/Discord/Zapier)
 *   console        -> toujours
 */
import { execFile } from 'node:child_process';
import type { Offer } from './sources.js';

export interface AlertConfig {
  ntfyTopics: string[];
  ntfyServer: string;
  macos: boolean;
  telegramToken?: string;
  telegramChatId?: string;
  webhookUrl?: string;
}

export function loadAlertConfig(): AlertConfig {
  const env = process.env;
  return {
    ntfyTopics: (env.NTFY_TOPIC ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean),
    ntfyServer: env.NTFY_SERVER || 'https://ntfy.sh',
    macos: env.ALERT_MACOS
      ? env.ALERT_MACOS === '1' || env.ALERT_MACOS === 'true'
      : process.platform === 'darwin',
    telegramToken: env.TELEGRAM_BOT_TOKEN,
    telegramChatId: env.TELEGRAM_CHAT_ID,
    webhookUrl: env.WEBHOOK_URL,
  };
}

/** Liste lisible des canaux actifs (pour log de démarrage). */
export function activeChannels(cfg: AlertConfig): string[] {
  const out = ['console'];
  for (const topic of cfg.ntfyTopics) out.push(`ntfy:${topic}`);
  if (cfg.macos) out.push('macOS');
  if (cfg.telegramToken && cfg.telegramChatId) out.push('telegram');
  if (cfg.webhookUrl) out.push('webhook');
  return out;
}


/** Les headers HTTP doivent être ASCII (ByteString) : on retire emoji/accents. */
function asciiHeader(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // diacritiques
    .replace(/[^\x20-\x7E]/g, '') // tout non-ASCII (emoji, —, …)
    .replace(/\s+/g, ' ')
    .trim();
}

async function sendNtfy(
  cfg: AlertConfig,
  topic: string,
  title: string,
  body: string,
  url: string,
  tags = 'rotating_light,snowflake',
): Promise<void> {
  const res = await fetch(`${cfg.ntfyServer}/${topic}`, {
    method: 'POST',
    headers: {
      // Le titre passe en header (ASCII) ; les emoji arrivent via Tags
      // (ntfy rend le nom de tag en emoji : "warning" => ⚠️).
      Title: asciiHeader(title) || 'Midea PortaSplit - EN STOCK',
      Priority: 'urgent',
      Tags: tags,
      Click: url,
    },
    body, // le corps (UTF-8) garde les emoji/accents
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`ntfy HTTP ${res.status}`);
}

async function sendTelegram(
  cfg: AlertConfig,
  title: string,
  body: string,
  url: string,
): Promise<void> {
  if (!cfg.telegramToken || !cfg.telegramChatId) return;
  const res = await fetch(
    `https://api.telegram.org/bot${cfg.telegramToken}/sendMessage`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        chat_id: cfg.telegramChatId,
        // URL dans le corps (cliquable), pas dans le titre gras.
        text: `*${title}*\n${body}\n${url}`,
        parse_mode: 'Markdown',
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(12_000),
    },
  );
  if (!res.ok) throw new Error(`telegram HTTP ${res.status}`);
}

async function sendWebhook(
  cfg: AlertConfig,
  title: string,
  body: string,
  offers: Offer[],
): Promise<void> {
  if (!cfg.webhookUrl) return;
  const res = await fetch(cfg.webhookUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: `${title}\n${body}`, offers }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`webhook HTTP ${res.status}`);
}

function sendMacOS(title: string, body: string, url: string): Promise<void> {
  return new Promise((resolve) => {
    const safe = (s: string) => s.replace(/["\\]/g, ' ').replace(/\n/g, ' · ');
    const full = url ? `${body} ${url}` : body; // macOS n'a pas de clic => URL dans le texte
    const script = `display notification "${safe(full)}" with title "${safe(title)}" sound name "Glass"`;
    execFile('osascript', ['-e', script], () => resolve());
  });
}

export interface NotifyInput {
  title: string;
  body: string;
  url?: string;
  tags?: string;
  offers?: Offer[];
}

/** Diffuse une notification sur tous les canaux actifs. Ne rejette jamais. */
export async function notifyAll(cfg: AlertConfig, n: NotifyInput): Promise<void> {
  const url =
    n.url ?? 'https://www.optimea.fr/product/climatiseur-split-mobile-midea/';
  const tags = n.tags ?? 'rotating_light,snowflake';
  const tasks: Array<[string, Promise<void>]> = [
    ...cfg.ntfyTopics.map(
      (topic): [string, Promise<void>] => [
        `ntfy:${topic}`,
        sendNtfy(cfg, topic, n.title, n.body, url, tags),
      ],
    ),
    ['telegram', sendTelegram(cfg, n.title, n.body, url)],
    ['webhook', sendWebhook(cfg, n.title, n.body, n.offers ?? [])],
  ];
  if (cfg.macos) tasks.push(['macOS', sendMacOS(n.title, n.body, url)]);
  const results = await Promise.allSettled(tasks.map(([, p]) => p));
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.error(
        `   ⚠️ canal "${tasks[i]?.[0] ?? '?'}" en échec : ${String(r.reason).slice(0, 120)}`,
      );
    }
  });
}

/**
 * Envoie UNE notification par destination (clic direct vers le marchand).
 * Les offres partageant la même URL/magasin sont regroupées. Ne rejette jamais.
 */
export async function dispatchAlert(cfg: AlertConfig, offers: Offer[]): Promise<void> {
  if (offers.length === 0) return;

  // Regroupe par destination : un magasin précis (mapsUrl) ne fusionne pas avec
  // les autres ; sinon on regroupe par URL produit (ex. livraison nationale).
  const groups = new Map<string, Offer[]>();
  for (const o of offers) {
    const groupKey = o.mapsUrl ?? o.url;
    const arr = groups.get(groupKey) ?? [];
    arr.push(o);
    groups.set(groupKey, arr);
  }

  console.log(`\n\x1b[1m\x1b[42m\x1b[30m  🎉 EN STOCK (${groups.size}) — Midea PortaSplit  \x1b[0m`);

  for (const [, items] of groups) {
    const first = items[0]!;
    const risky = items.some((o) => o.risky);
    const prefix = risky ? '[A VERIFIER - vendeur peu connu] ' : 'EN STOCK ';
    const extra = items.length > 1 ? ` (+${items.length - 1})` : '';
    const title = `${risky ? '⚠️' : '🎉'} ${prefix}${first.label}${extra}`;
    const body =
      (risky
        ? '⚠️ Vendeur peu connu : vérifie avis + paie en CB/PayPal avant de commander.\n'
        : '') +
      (items.length > 1
        ? items.map((o) => `• ${o.label}`).join('\n')
        : first.label) +
      '\n👉 Clique pour ouvrir/commander' +
      (first.mapsUrl
        ? `\n⚠️ Sur la page, sélectionne bien LE magasin ci-dessus (le site peut en afficher un autre par défaut).` +
          `\n📍 Itinéraire magasin : ${first.mapsUrl}`
        : '');
    const tags = risky ? 'warning' : 'rotating_light,snowflake';

    console.log(`   \x1b[32m→ ${title}\x1b[0m  \x1b[36m${first.url}\x1b[0m`);
    await notifyAll(cfg, { title, body, url: first.url, tags, offers: items });
  }
}
