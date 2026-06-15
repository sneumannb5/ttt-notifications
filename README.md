# TimeTree → Telegram Benachrichtigungen

Schickt automatisch eine Telegram-Nachricht, wenn in einem TimeTree-Kalender
ein neues Event erstellt (oder geändert) wird – mit Titel, Datum, Beschreibung
und Link. Läuft kostenlos auf GitHub Actions, **ohne dauerhaft laufendes Gerät**.

> ⚠️ Nutzt die inoffizielle TimeTree-Web-API. Das kann jederzeit kaputtgehen,
> wenn TimeTree etwas umbaut. Für ein kleines Team-Newsboard okay, aber kein
> „einmal bauen, nie wieder anfassen“.

---

## Was du brauchst (alles kostenlos)

1. Einen **TimeTree-Account** (am besten einen Extra-/Dummy-Account), der in
   Renés Kalender Mitglied ist.
2. Einen **Telegram-Bot** + einen **Telegram-Kanal**, dem deine CrossFit-Leute beitreten.
3. Ein **(privates) GitHub-Repo** mit diesen Dateien.

---

## Schritt 1 – Telegram einrichten

1. In Telegram **@BotFather** anschreiben → `/newbot` → Namen vergeben →
   du bekommst einen **Bot-Token** (sieht aus wie `12345:ABC...`).
2. Einen **Kanal** erstellen (das ist die „Newsletter“-Seite für deine Leute).
   Den Bot als **Administrator** zum Kanal hinzufügen.
3. Die **Chat-ID** des Kanals herausfinden: Bei einem öffentlichen Kanal reicht
   `@deinkanalname`. Bei einem privaten Kanal: einmal etwas posten, dann
   `https://api.telegram.org/bot<TOKEN>/getUpdates` im Browser öffnen und die
   `chat.id` ablesen (beginnt meist mit `-100…`).
4. Deine Leute abonnieren später einfach über den **Einladungslink** des Kanals.

## Schritt 2 – Repo anlegen

- Lege ein **privates** Repo an und lege dort ab:
  - `notify.js`
  - `.github/workflows/notify.yml`  (die mitgelieferte `notify.yml` dorthin)
- `state.json` wird automatisch vom Skript erzeugt und ins Repo geschrieben.

## Schritt 3 – Den richtigen Kalender finden

Setze erstmal nur `TIMETREE_EMAIL` und `TIMETREE_PASSWORD` als Secrets
(siehe Schritt 4) und starte den Workflow einmal manuell **ohne** `CALENDAR_ID`.
Im Log werden alle Kalender mit ihrer `id` aufgelistet. Die passende `id` dann
als Secret `CALENDAR_ID` eintragen.

## Schritt 4 – Secrets setzen

Im Repo unter **Settings → Secrets and variables → Actions → New repository secret**:

| Secret                | Wert                                            |
|-----------------------|-------------------------------------------------|
| `TIMETREE_EMAIL`      | E-Mail des Dummy-Accounts                        |
| `TIMETREE_PASSWORD`   | Passwort des Dummy-Accounts                      |
| `TELEGRAM_BOT_TOKEN`  | Token von @BotFather                             |
| `TELEGRAM_CHAT_ID`    | `@deinkanal` oder die `-100…`-ID                 |
| `CALENDAR_ID`         | aus Schritt 3                                    |
| `AUTHOR_FILTER`       | *(optional)* nur Events von René – siehe unten   |

## Schritt 5 – Läuft

Der Workflow startet alle ~20 Minuten von selbst (oder per Knopf unter
**Actions → Run workflow**). Der **erste echte Lauf** merkt sich nur den
aktuellen Stand und verschickt nichts – ab dann kommen nur noch neue/geänderte
Events. So wirst du nicht mit alten Events zugespammt.

---

## Feinheiten / ehrliche Grenzen

- **Beschreibung:** kommt zuverlässig mit (Feld `note`).
- **Kommentare:** Die `events/sync`-Schnittstelle liefert **keine Kommentare** –
  die hängen an einem separaten, undokumentierten Endpunkt. Als Ersatz meldet
  das Skript, wenn ein bestehendes Event **geändert** wurde (`✏️`), z.B. wenn
  René nachträglich die Beschreibung ergänzt. Echte Kommentar-Threads müsste man
  per Browser-Netzwerk-Tab nachschauen und separat anbinden.
- **„Nur von René“ (`AUTHOR_FILTER`):** TimeTree benennt das Ersteller-Feld nicht
  eindeutig. So findest du den richtigen Wert: Workflow einmal mit Repo-Variable
  `DEBUG_DUMP=1` laufen lassen (oder lokal `DEBUG_DUMP=1 node notify.js`). Im Log
  siehst du ein Beispiel-Event mit allen Feldern – dort die ID/den Namen von René
  ablesen und als `AUTHOR_FILTER` eintragen. Lässt du das Secret leer, kommen
  Benachrichtigungen für **alle** neuen Events.
- **Link:** Das Linkformat ist ein begründeter Best-Effort. Falls der Link mal
  nicht direkt aufs Event springt: ein Event im Browser öffnen, das Format in der
  Adresszeile ansehen und in `notify.js` die Funktion `eventLink()` anpassen.
- **Tempo:** GitHub-Cron läuft nicht sekundengenau und kann sich bei Last etwas
  verzögern. Für Event-Ankündigungen völlig ausreichend.

## Lokal testen

```bash
TIMETREE_EMAIL=... TIMETREE_PASSWORD=... node notify.js          # listet Kalender
TIMETREE_EMAIL=... TIMETREE_PASSWORD=... CALENDAR_ID=... \
  TELEGRAM_BOT_TOKEN=... TELEGRAM_CHAT_ID=... node notify.js      # echter Lauf
```
