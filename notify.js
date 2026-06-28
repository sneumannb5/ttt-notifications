/**
 * TimeTree -> Telegram + WhatsApp (Whapi) Notifier
 * ------------------------------------------------
 * Loggt sich mit einem Dummy-TimeTree-Account ein (der in Renés Kalender ist),
 * holt die Events und schickt neue/geaenderte Events raus -- an Telegram und/oder
 * an eine WhatsApp-Gruppe ueber Whapi.Cloud.
 *
 * - Telegram aktiv, wenn TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID gesetzt sind.
 * - WhatsApp aktiv, wenn WHAPI_TOKEN + WHAPI_TO gesetzt sind.
 *
 * Laeuft auf Node 18+ (nutzt globales fetch). Keine npm-Pakete noetig.
 *
 * WICHTIG: Das nutzt die INOFFIZIELLE TimeTree-Web-API. Die kann sich jederzeit
 * aendern. Wenn ploetzlich nichts mehr kommt, hier zuerst gucken.
 */

const fs = require("node:fs");
const crypto = require("node:crypto");

// ---- Konfiguration kommt aus Umgebungsvariablen (GitHub Actions Secrets) ----
const EMAIL = process.env.TIMETREE_EMAIL;
const PASSWORD = process.env.TIMETREE_PASSWORD;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TG_CHAT = process.env.TELEGRAM_CHAT_ID;
const CALENDAR_ID = process.env.CALENDAR_ID; // optional: wenn leer, listet das Skript nur die Kalender auf
const AUTHOR_FILTER = (process.env.AUTHOR_FILTER || "").trim(); // optional: nur Events von z.B. René
const STATE_FILE = process.env.STATE_FILE || "state.json";
const DEBUG_DUMP = process.env.DEBUG_DUMP === "1"; // 1 = rohe API-Daten ausgeben (zum Felder-Finden)

// ---- WhatsApp via Whapi.Cloud (optional) ----
const WHAPI_TOKEN = process.env.WHAPI_TOKEN;   // Channel-Token aus dem Whapi-Dashboard
const WHAPI_TO = process.env.WHAPI_TO;         // Gruppen-ID, Form "...@g.us" (oder Kanal "...@newsletter")
const WHAPI_BASE = process.env.WHAPI_BASE || "https://gate.whapi.cloud";

const API_BASE = "https://timetreeapp.com/api/v1";
const UA = "web/2.1.0/en"; // dieser Header ist Pflicht, sonst antwortet die API nicht

const telegramEnabled = Boolean(TG_TOKEN && TG_CHAT);
const whatsappEnabled = Boolean(WHAPI_TOKEN && WHAPI_TO);

// ----------------------------------------------------------------------------
// TimeTree
// ----------------------------------------------------------------------------

async function login(email, password) {
  const res = await fetch(`${API_BASE}/auth/email/signin`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", "X-Timetreea": UA },
    body: JSON.stringify({
      uid: email,
      password,
      uuid: crypto.randomUUID().replace(/-/g, ""),
    }),
  });

  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`Login fehlgeschlagen (${res.status}): ${text}`);
  }

  // Das Session-Cookie steckt im Set-Cookie-Header
  const cookies = res.headers.getSetCookie
    ? res.headers.getSetCookie()
    : [res.headers.get("set-cookie") || ""];
  const match = cookies.join("; ").match(/_session_id=([^;]+)/);
  if (!match) throw new Error("Kein _session_id-Cookie erhalten");
  return match[1];
}

async function apiGet(sessionId, path) {
  const res = await fetch(`${API_BASE}${path}`, {
    headers: {
      "Content-Type": "application/json",
      "X-Timetreea": UA,
      Cookie: `_session_id=${sessionId}`,
    },
  });
  if (res.status !== 200) {
    const text = await res.text();
    throw new Error(`GET ${path} -> ${res.status}: ${text}`);
  }
  return res.json();
}

async function getCalendars(sessionId) {
  const data = await apiGet(sessionId, "/calendars?since=0");
  return data.calendars || [];
}

// Holt alle Events; die API liefert in "Chunks", deshalb ggf. mehrfach nachladen
async function getEvents(sessionId, calendarId) {
  let all = [];
  let since = null;
  for (let guard = 0; guard < 50; guard++) {
    const path =
      since == null
        ? `/calendar/${calendarId}/events/sync`
        : `/calendar/${calendarId}/events/sync?since=${since}`;
    const data = await apiGet(sessionId, path);
    all = all.concat(data.events || []);
    if (data.chunk === true && data.since != null) {
      since = data.since;
    } else {
      break;
    }
  }
  return all;
}

// ----------------------------------------------------------------------------
// Hilfsfunktionen
// ----------------------------------------------------------------------------

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { events: {}, initialized: false };
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

function fmtDate(ms, allDay) {
  if (!ms) return "";
  const d = new Date(ms);
  const opts = allDay
    ? { dateStyle: "full", timeZone: "Europe/Berlin" }
    : { dateStyle: "full", timeStyle: "short", timeZone: "Europe/Berlin" };
  return new Intl.DateTimeFormat("de-DE", opts).format(d);
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Bester Versuch fuer einen Direktlink. Wenn der nicht stimmt, beim Oeffnen eines
// Events im Browser in die Adresszeile schauen und das Format hier anpassen.
function eventLink(calendarId, ev) {
  return `https://timetreeapp.com/calendars/${calendarId}/events/${ev.uuid}`;
}

// Best-effort: versucht, den Ersteller eines Events zu finden. TimeTree benennt
// das Feld nicht eindeutig - deshalb mehrere Kandidaten pruefen.
function authorOf(ev) {
  return (
    ev.author_id ?? ev.creator_id ?? ev.updated_by ?? ev.created_by ?? ev.author ?? ""
  );
}

// Telegram-Format (HTML)
function buildMessage(calendarId, ev, isUpdate) {
  const tag = isUpdate ? "✏️ Event aktualisiert" : "🆕 Neues Event";
  const lines = [`<b>${tag}</b>`, "", `<b>${esc(ev.title || "(ohne Titel)")}</b>`];
  const when = fmtDate(ev.start_at, ev.all_day);
  if (when) lines.push(`📅 ${esc(when)}`);
  if (ev.location) lines.push(`📍 ${esc(ev.location)}`);
  if (ev.note && ev.note.trim()) {
    lines.push("", esc(ev.note.trim()));
  }
  return lines.join("\n");
}

// WhatsApp-Format (nutzt *fett*, kein HTML)
function buildMessageWhatsApp(calendarId, ev, isUpdate) {
  const tag = isUpdate ? "✏️ Event aktualisiert" : "🆕 Neues Event";
  const lines = [`*${tag}*`, "", `*${ev.title || "(ohne Titel)"}*`];
  const when = fmtDate(ev.start_at, ev.all_day);
  if (when) lines.push(`📅 ${when}`);
  if (ev.location) lines.push(`📍 ${ev.location}`);
  if (ev.note && ev.note.trim()) {
    lines.push("", ev.note.trim());
  }
  return lines.join("\n");
}

async function sendTelegram(text) {
  const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TG_CHAT,
      text,
      parse_mode: "HTML",
      disable_web_page_preview: false,
    }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Telegram-Versand fehlgeschlagen: ${t}`);
  }
}

// Sendet an eine WhatsApp-Gruppe (oder Kanal) ueber Whapi.Cloud.
// WHAPI_TO ist die Ziel-ID: Gruppe "...@g.us" oder Kanal "...@newsletter".
async function sendWhapi(text) {
  const res = await fetch(`${WHAPI_BASE}/messages/text`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${WHAPI_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ to: WHAPI_TO, body: text }),
  });
  if (!res.ok) {
    const t = await res.text();
    throw new Error(`Whapi-Versand fehlgeschlagen: ${t}`);
  }
}

// ----------------------------------------------------------------------------
// Hauptablauf
// ----------------------------------------------------------------------------

async function main() {
  if (!EMAIL || !PASSWORD) throw new Error("TIMETREE_EMAIL / TIMETREE_PASSWORD fehlen");
  if (!telegramEnabled && !whatsappEnabled) {
    throw new Error("Kein Kanal konfiguriert: setze Telegram- und/oder Whapi-Variablen.");
  }
  console.log(
    `Aktive Kanaele: ${[telegramEnabled && "Telegram", whatsappEnabled && "WhatsApp"].filter(Boolean).join(", ")}`
  );

  const sessionId = await login(EMAIL, PASSWORD);
  console.log("Login ok.");

  // Kein Kalender gewaehlt? Dann nur auflisten und beenden (zum IDs finden).
  if (!CALENDAR_ID) {
    const cals = await getCalendars(sessionId);
    console.log("Verfuegbare Kalender (nutze die id als CALENDAR_ID):");
    for (const c of cals) console.log(`  id=${c.id}  name=${c.name}`);
    if (DEBUG_DUMP) console.log(JSON.stringify(cals, null, 2));
    return;
  }

  const events = await getEvents(sessionId, CALENDAR_ID);
  console.log(`Geladen: ${events.length} Events.`);

  if (DEBUG_DUMP && events.length) {
    console.log("Felder eines Events:", Object.keys(events[0]).join(", "));
    console.log("Beispiel-Event (roh):", JSON.stringify(events[0], null, 2));
  }

  const state = loadState();

  // Erster Lauf: alles als "gesehen" merken, aber NICHT benachrichtigen
  // (sonst kommen alle Alt-Events auf einmal).
  if (!state.initialized) {
    for (const ev of events) state.events[ev.uuid] = ev.updated_at || 0;
    state.initialized = true;
    saveState(state);
    console.log("Erstlauf: Stand gespeichert, keine Nachrichten verschickt.");
    return;
  }

  let sent = 0;
  for (const ev of events) {
    // optionaler Personen-Filter (z.B. nur René)
    if (AUTHOR_FILTER) {
      const a = String(authorOf(ev));
      if (!a.includes(AUTHOR_FILTER)) {
        state.events[ev.uuid] = ev.updated_at || 0; // trotzdem merken, damit es spaeter nicht "neu" wirkt
        continue;
      }
    }

    const known = state.events[ev.uuid];
    const isNew = known === undefined;
    const isUpdate = !isNew && (ev.updated_at || 0) > known;

    if (isNew || isUpdate) {
      // Jeder Kanal einzeln: ein Fehler bricht den anderen nicht ab.
      if (telegramEnabled) {
        try {
          await sendTelegram(buildMessage(CALENDAR_ID, ev, isUpdate));
        } catch (e) {
          console.error("Telegram fehlgeschlagen fuer", ev.uuid, e.message);
        }
      }
      if (whatsappEnabled) {
        try {
          await sendWhapi(buildMessageWhatsApp(CALENDAR_ID, ev, isUpdate));
        } catch (e) {
          console.error("WhatsApp fehlgeschlagen fuer", ev.uuid, e.message);
        }
      }
      sent++;
    }

    // Best-effort: nach dem Versuch immer merken ->
    // keine Endlos-Wiederholung und kein Doppel-Spam auf dem Kanal, der funktioniert hat.
    state.events[ev.uuid] = ev.updated_at || 0;
  }

  saveState(state);
  console.log(`Fertig. ${sent} Event(s) verarbeitet.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
