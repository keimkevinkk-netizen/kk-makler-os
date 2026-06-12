/*
 * KK Makler-OS · Netlify Function "ai-assistant"
 * ------------------------------------------------------------------
 * Dein Frontend (KK_AI_ASSISTANT_V1.requestRealAI) ruft genau diesen
 * Endpunkt auf: POST /.netlify/functions/ai-assistant
 *
 * SICHERHEIT:
 *  - Der API-Key liegt AUSSCHLIESSLICH in den Netlify Environment Variables
 *    (OPENAI_API_KEY). Er steht niemals im Frontend-Code.
 *  - Das Frontend sieht nur das fertige Ergebnis, nie den Key.
 *
 * KOSTENKONTROLLE:
 *  - Harte Begrenzung der Eingabe-Größe (MAX_PAYLOAD_CHARS).
 *  - Harte Begrenzung der Antwort-Tokens (max_tokens).
 *  - Günstiges Default-Modell (OPENAI_MODEL, Standard: gpt-4o-mini).
 *  - Timeout, damit keine hängende Abfrage Geld kostet.
 *
 * ROBUSTHEIT:
 *  - Ohne Key ODER bei jedem Fehler liefert die Function einen
 *    regelbasierten Server-Fallback zurueck. Das Frontend bekommt
 *    also IMMER ein nutzbares Briefing, nie einen harten Fehler.
 */

'use strict';

const MAX_PAYLOAD_CHARS = 24000; // schuetzt vor zu grossen (teuren) Requests
const REQUEST_TIMEOUT_MS = 20000;

const CORS = {
  'Access-Control-Allow-Origin': '*', // bei Bedarf auf deine Netlify-Domain einschraenken
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json; charset=utf-8'
};

function json(statusCode, obj) {
  return { statusCode, headers: CORS, body: JSON.stringify(obj) };
}

/* ---- Server-seitiger Fallback (laeuft auch ganz ohne API-Key) ---- */
function ruleBasedBriefing(payload) {
  const b = (payload && payload.briefing) || {};
  const tasks = Array.isArray(payload && payload.tasks) ? payload.tasks : [];
  const top = tasks.slice(0, 5);
  const lines = [];

  lines.push('TAGESBRIEFING (regelbasiert · ohne KI-API berechnet)');
  lines.push('');
  if (b.main) lines.push('Wichtigste Aktion heute: ' + b.main);
  if (b.region && b.region.area) lines.push('Beste Akquise-Region: ' + b.region.area);
  if (b.bottleneck) lines.push('Engpass: ' + b.bottleneck);
  lines.push('');
  lines.push('Top-Aktionen:');
  if (top.length) {
    top.forEach((t, i) => {
      const who = t.contact && t.contact !== 'Unbenannter Eintrag' ? ' (' + t.contact + ')' : '';
      lines.push((i + 1) + '. ' + (t.title || 'Aktion') + who + ' · Score ' + (t.score || '?') + '/100');
      if (t.nextStep) lines.push('   → ' + t.nextStep);
    });
  } else {
    lines.push('Noch keine Aktionen erkannt. CRM, Follow-ups oder Pipeline befuellen.');
  }

  return {
    ok: true,
    mode: 'fallback-server',
    note: 'Kein OPENAI_API_KEY gesetzt oder KI-Aufruf fehlgeschlagen. Es wurde ein regelbasiertes Briefing erzeugt.',
    briefingText: lines.join('\n'),
    generatedAt: new Date().toISOString()
  };
}

/* ---- Prompt-Bau: kompakt, deutsch, vertriebsorientiert ---- */
function buildMessages(payload) {
  const b = (payload && payload.briefing) || {};
  const tasks = (Array.isArray(payload && payload.tasks) ? payload.tasks : []).slice(0, 25);

  // Nur die fuer die Analyse noetigen Felder weitergeben (datensparsam)
  const slimTasks = tasks.map(t => ({
    title: t.title, type: t.type, contact: t.contact, area: t.area,
    score: t.score, priority: t.priority, why: t.why, nextStep: t.nextStep, channel: t.channel
  }));

  const system =
    'Du bist der persoenliche Vertriebsleiter und Marktanalyst eines selbststaendigen ' +
    'Immobilienmaklers (Rhein-Main / Main-Kinzig-Kreis). Du arbeitest im Hintergrund, ' +
    'nicht als Chatbot. Antworte knapp, konkret, operativ und auf Deutsch. ' +
    'Kein Marketing-Sprech, keine Floskeln, keine Risiko-Disclaimer. ' +
    'Priorisiere klar nach Umsatzwirkung. Gib pro Punkt einen konkreten naechsten Schritt.';

  const user =
    'Hier sind die heute erkannten Daten des Makler-OS (lokal vorberechnet). ' +
    'Erstelle daraus ein scharfes Tagesbriefing.\n\n' +
    'Liefere genau diese Abschnitte:\n' +
    '1) WICHTIGSTE AKTION HEUTE (1 Satz, mit Begruendung)\n' +
    '2) TOP 5 NAECHSTE BESTE AKTIONEN (je: Wen, Warum, Kanal, konkretes Ziel)\n' +
    '3) HEISSESTE EIGENTUEMERCHANCE\n' +
    '4) KRITISCHSTER PIPELINE-FALL\n' +
    '5) BESTE AKQUISE-REGION + 1 konkreter Akquise-Ansatz\n' +
    '6) ENGPASS DES TAGES (was Kevin sonst Geld kostet)\n\n' +
    'Daten:\n' +
    JSON.stringify({ briefing: b, tasks: slimTasks });

  return [
    { role: 'system', content: system },
    { role: 'user', content: user }
  ];
}

async function callOpenAI(payload, apiKey) {
  const model = process.env.OPENAI_MODEL || 'gpt-4o-mini';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        model,
        messages: buildMessages(payload),
        temperature: 0.4,
        max_tokens: 900 // Kostenkontrolle: harte Obergrenze
      })
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error('OpenAI HTTP ' + res.status + ' ' + errText.slice(0, 200));
    }

    const data = await res.json();
    const text =
      data &&
      data.choices &&
      data.choices[0] &&
      data.choices[0].message &&
      data.choices[0].message.content;

    if (!text) throw new Error('Leere KI-Antwort');

    return {
      ok: true,
      mode: 'live',
      model,
      briefingText: String(text).trim(),
      usage: data.usage || null,
      generatedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timer);
  }
}

exports.handler = async function (event) {
  // Preflight
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: CORS, body: '' };
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'Nur POST erlaubt.' });
  }

  // Eingabe lesen + Groesse begrenzen
  let payload = {};
  try {
    const raw = event.body || '{}';
    if (raw.length > MAX_PAYLOAD_CHARS) {
      return json(413, { ok: false, error: 'Payload zu gross.' });
    }
    payload = JSON.parse(raw);
  } catch (e) {
    return json(400, { ok: false, error: 'Ungueltiges JSON.' });
  }

  const apiKey = process.env.OPENAI_API_KEY;

  // Kein Key -> sauberer Server-Fallback (kein Fehler fuer das Frontend)
  if (!apiKey) {
    return json(200, ruleBasedBriefing(payload));
  }

  // Mit Key -> echte KI, bei Fehler ebenfalls Fallback
  try {
    const result = await callOpenAI(payload, apiKey);
    return json(200, result);
  } catch (err) {
    const fb = ruleBasedBriefing(payload);
    fb.note = 'KI-Aufruf fehlgeschlagen (' + (err && err.message ? err.message : 'unbekannt') + '). Regelbasiertes Briefing geliefert.';
    return json(200, fb);
  }
};
