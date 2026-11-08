# LLM Sidebar

[English](README.md) · **Deutsch**

Eine KI-Seitenleiste für **Chrome** und **Firefox**, in der du **deinen eigenen API-Schlüssel**
und **deinen eigenen Anbieter** verwendest: OpenAI, Claude (Anthropic), Grok (xAI), OpenRouter,
Z.AI (GLM), Google Gemini, Mistral, DeepSeek, Groq, Ollama Cloud, lokale Modelle über Ollama oder
LM Studio
und beliebige eigene OpenAI- oder Anthropic-kompatible Endpunkte.

Alles bleibt lokal in deinem Browser: Einstellungen, API-Schlüssel und Chatverläufe. Es gibt
keinen eigenen Server, kein Konto und keine Telemetrie. Nur deine eigentliche Anfrage geht direkt
an den Anbieter, den du ausgewählt hast.

## Funktionen

- **Chat in der Seitenleiste**: mehrere Chats mit Verlauf und Suche, Streaming-Antworten,
  Markdown mit Code-Blöcken, Modellwechsel pro Chat, Personas und eigene Systemprompts
- **Mit der Webseite chatten**: Schalte „Seite“ ein, dann wird der Inhalt des aktiven Tabs als
  Kontext mitgeschickt, z. B. zum Zusammenfassen oder für Fragen zum Artikel
- **YouTube-Videos zusammenfassen**: Ist im aktiven Tab ein YouTube-Video geöffnet, bietet die
  Seitenleiste „Video zusammenfassen“ an. Grundlage ist das Transkript des Videos (sofern es eines
  gibt, sonst Titel, Beschreibung und Kapitel). Die Zusammenfassung erscheint in der Sprache, die du
  in der Karte oder unter **Einstellungen → Übersetzung & Toolbar → YouTube-Videos** wählst, und
  enthält Zeitstempel: Ein Klick auf `[3:15]` springt im Video an diese Stelle. Danach kannst du
  einfach weiter Fragen zum Video stellen, oder über „Fragen zum Video stellen“ direkt mit dem
  Inhalt chatten, ohne vorher zusammenzufassen.
- **Bilder**: Bilder anhängen (für Modelle mit Bildverständnis) und Bilder generieren (OpenAI,
  Grok, Gemini, Z.AI, OpenRouter …), entweder über 🖼 oder mit `/bild <Beschreibung>`
- **Text-Werkzeuge auf jeder Webseite**: Wenn du Text markierst, erscheint eine kleine
  Werkzeugleiste mit Verbessern, Umschreiben, Korrigieren, Kürzen, Ausführlicher, Formeller,
  Lockerer, Personalisieren, Zusammenfassen, Erklären, Antwort entwerfen und Übersetzen.
  Das Ergebnis kannst du kopieren, direkt im Eingabefeld ersetzen, weiter anpassen („kürzer“,
  „mit Du“) oder im Chat fortsetzen. Das klappt auch in eingebetteten Editoren (iframes), wie
  sie viele Webmailer und CMS verwenden.
- **Übersetzen**: die markierte Stelle oder die **ganze Seite** direkt im Text. Mit einem Klick
  kannst du zwischen Original und Übersetzung wechseln, auch nachgeladene Inhalte werden
  übersetzt.
- **Kontextmenü** (Rechtsklick → „LLM Sidebar“) mit allen Schnellaktionen, Übersetzen, „Im Chat
  fragen“, Seite übersetzen, Original wiederherstellen und Seite zusammenfassen
- **Tastenkürzel**: `Alt+Shift+L` öffnet die Seitenleiste, `Alt+Shift+T` übersetzt die Seite.
  Für „Originalseite wiederherstellen“ und „Seite zusammenfassen“ kannst du selbst ein Kürzel
  festlegen (siehe [Bedienung](#bedienung)).
- **Eigene Schnellaktionen**: Prompts, Symbole und Reihenfolge frei anpassbar
- **Personalisierung**: Hinterlege „Über mich“ und deinen Schreibstil. Die Aktion
  „Personalisieren“ (und auf Wunsch auch der Chat) nutzt diese Angaben.
- **Kosten & Guthaben**: Neben jeder Antwort stehen die verbrauchten Tokens und die Kosten
  (von OpenRouter und xAI gemeldet, sonst aus dem Preis pro Token geschätzt; im ⋯-Menü auch die
  Summe des Chats). Auch Ergebnisse von Schnellaktionen und Übersetzungen zeigen Tokens und Kosten –
  bei der Seitenübersetzung die Summe aller Anfragen der Seite direkt in der Statusanzeige. Unter
  **Einstellungen → Kosten & Guthaben** siehst du den Verbrauch pro Monat,
  Anbieter und Modell (Chat, Schnellaktionen, Übersetzungen, Bilder) und kannst eigene Preise
  eintragen. Das Restguthaben fragen OpenRouter (Limit und Verbrauch des Schlüssels) und DeepSeek
  direkt ab, xAI mit einem zusätzlichen Management-Schlüssel (einrichten unter **Kosten &
  Guthaben → xAI → Einrichten**). OpenAI, Anthropic, Google und die anderen Anbieter geben es mit
  einem normalen API-Schlüssel nicht heraus, dafür gibt es einen Link ins jeweilige Konto.
- **Mehrsprachig**: Die Oberfläche gibt es auf Deutsch, Englisch, Spanisch, Französisch,
  Italienisch, Portugiesisch (Brasilien), Niederländisch, Polnisch, Türkisch, Russisch, Japanisch
  und Chinesisch (vereinfacht). Sie folgt automatisch der Browsersprache und lässt sich unter
  **Einstellungen → Darstellung → Sprache** umstellen. Übersetzungen und Video-Zusammenfassungen
  gehen standardmäßig in die Sprache der Oberfläche.
- Helles und dunkles Design, Export und Import von Einstellungen und Chats

**Umfang:** Von den Anbieter-APIs nutzt die Erweiterung Text-Chat, Bildverständnis (angehängte
Bilder, sofern das Modell das kann) und Bildgenerierung (sofern der Anbieter sie anbietet), dazu
den Inhalt der aktuellen Webseite als Kontext. Darauf bauen Chat, Schnellaktionen und Übersetzung
auf. Andere Funktionen mancher Anbieter werden bewusst **nicht** unterstützt: Vorlesen (Text-to-Speech),
Spracheingabe/Transkription, Video-Generierung, die eingebaute Websuche der Anbieter, Datei- und
PDF-Anhänge sowie Werkzeugaufrufe (Tools/Agenten).

## Installation

Voraussetzung zum Bauen ist [Node.js](https://nodejs.org) ab Version 22. Es werden keine
zusätzlichen Pakete installiert.

```bash
npm run build
```

Danach liegen die fertigen Erweiterungen in `dist/chrome` und `dist/firefox`.
Unterstützt werden Chrome, Edge und Brave ab Version 116 sowie Firefox ab Version 142.

### Chrome, Edge, Brave

1. `chrome://extensions` öffnen (Edge: `edge://extensions`)
2. Oben rechts den **Entwicklermodus** einschalten
3. **„Entpackte Erweiterung laden“** und den Ordner `dist/chrome` auswählen
4. Das Symbol über das Puzzle-Menü anheften. Ein Klick darauf öffnet die Seitenleiste.

### Firefox

**Zum Ausprobieren (bis zum nächsten Neustart):**

1. `about:debugging#/runtime/this-firefox` öffnen
2. **„Temporäres Add-on laden …“** und darin `dist/firefox/manifest.json` auswählen
3. **Zugriff auf Webseiten erlauben** (siehe unten)
4. Die Seitenleiste öffnest du über das Symbol in der Symbolleiste oder mit `Alt+Shift+L`

**Dauerhaft installieren:** Firefox installiert dauerhaft nur signierte Add-ons. Du hast zwei
Möglichkeiten:

- Kostenlos auf [addons.mozilla.org](https://addons.mozilla.org/developers/) als „nicht gelistet“
  (Selbstvertrieb) signieren lassen. Die Zip-Datei dafür erzeugt `npm run zip`.
  Mit [web-ext](https://github.com/mozilla/web-ext) geht das auch per Befehl:
  `web-ext sign --channel=unlisted --source-dir dist/firefox --api-key=… --api-secret=…`
- Oder **Firefox Developer Edition / Nightly** verwenden und in `about:config` den Wert
  `xpinstall.signatures.required` auf `false` setzen

**Zugriff auf Webseiten erlauben:** Für die Werkzeugleiste, die Seitenübersetzung, den
Seitenkontext im Chat und für Anfragen an manche Anbieter braucht die Erweiterung Zugriff auf
alle Webseiten. Firefox erteilt ihn nicht immer automatisch: Bei einer dauerhaften Installation
fragt Firefox im Installationsdialog danach, bei einem temporären Add-on kann er fehlen, und du
kannst ihn jederzeit wieder entziehen.

1. Fehlt der Zugriff, zeigen die Einstellungen (sie öffnen sich nach der Installation von
   selbst) und die Seitenleiste oben einen Hinweis mit dem Button **„Zugriff erlauben“**.
2. Klicke darauf und bestätige die Abfrage von Firefox mit **„Erlauben“**.
3. Alternativ: `about:addons` → LLM Sidebar → Reiter **Berechtigungen** → „Auf Ihre Daten für
   alle Websites zugreifen“ einschalten. Dort kannst du den Zugriff auch wieder entziehen.

Tabs, die schon vorher offen waren, danach einmal neu laden.

## Erste Schritte

1. Nach der Installation öffnen sich die **Einstellungen** automatisch (sonst: Rechtsklick auf das
   Symbol → Optionen, oder das Zahnrad in der Seitenleiste).
2. Unter **Anbieter** den API-Schlüssel eintragen. Der Anbieter wird dadurch automatisch
   aktiviert. Mit **„Verbindung testen“** prüfst du den Schlüssel, mit **„Modelle laden“** holst du
   die aktuelle Modellliste.
3. Optional unter **Standardmodelle** festlegen, welches Modell für Chat, Schnellaktionen,
   Übersetzung und Bilder genutzt wird. Ohne Auswahl nimmt die Erweiterung den ersten bereiten
   Anbieter.

| Anbieter | Schlüssel erstellen | Bilder generieren |
|---|---|---|
| OpenAI | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | ja (GPT Image) |
| Claude (Anthropic) | [console.anthropic.com](https://console.anthropic.com/settings/keys) | nein |
| OpenRouter | [openrouter.ai/keys](https://openrouter.ai/keys) | ja (je nach Modell) |
| Grok (xAI) | [console.x.ai](https://console.x.ai) | ja (Grok Imagine) |
| Z.AI (GLM) | [z.ai](https://z.ai/manage-apikey/apikey-list) | ja (GLM-Image) |
| Google Gemini | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | ja |
| Mistral | [console.mistral.ai](https://console.mistral.ai/api-keys) | nein |
| DeepSeek | [platform.deepseek.com](https://platform.deepseek.com/api_keys) | nein |
| Groq | [console.groq.com/keys](https://console.groq.com/keys) | nein |
| Ollama Cloud | [ollama.com/settings/keys](https://ollama.com/settings/keys) (mit Ollama-Abo oder nach Verbrauch) | nein |
| Ollama / LM Studio (lokal) | kein Schlüssel nötig | nein |
| Eigener Anbieter | beliebige OpenAI- oder Anthropic-kompatible URL | je nach Server |

### Lokale Modelle (komplett offline)

- **Ollama**: Ollama lässt Anfragen von Browser-Erweiterungen nur zu, wenn du das erlaubst. Setze
  die Umgebungsvariable `OLLAMA_ORIGINS` auf
  `chrome-extension://*,moz-extension://*` und starte Ollama neu.
  Unter Windows geht das über Einstellungen → System → Info → Erweiterte Systemeinstellungen →
  Umgebungsvariablen → Benutzervariable „Neu“. Danach Ollama über das Tray-Symbol beenden und
  neu starten.
- **LM Studio**: Unter Developer → Server Settings **„Enable CORS“** einschalten und den Server
  starten.

## Bedienung

| Was | Wie |
|---|---|
| Seitenleiste öffnen | Klick auf das Symbol oder `Alt+Shift+L` |
| Text bearbeiten | Text markieren → Werkzeugleiste, oder Rechtsklick → LLM Sidebar |
| Ganze Seite übersetzen | `Alt+Shift+T`, Rechtsklick → „Seite übersetzen“ oder ⋯-Menü in der Seitenleiste |
| Original wiederherstellen | „Original“ in der Statusanzeige unten rechts, Rechtsklick → „Originalseite wiederherstellen“ oder ⋯-Menü in der Seitenleiste |
| Seite zusammenfassen | Vorschlag „Seite zusammenfassen“ in der Seitenleiste oder Rechtsklick |
| YouTube-Video zusammenfassen | Video öffnen → Karte „YouTube-Video erkannt“ in der Seitenleiste, ⋯-Menü → „Video zusammenfassen“; „Seite zusammenfassen“ nutzt auf YouTube ebenfalls das Transkript |
| Bild generieren | 🖼 in der Eingabezeile oder `/bild <Beschreibung>` |
| Werkzeugleiste auf einer Website ausblenden | ⋯ in der Werkzeugleiste → „Auf dieser Website ausblenden“ |

Vorbelegt sind nur zwei Tastenkürzel: `Alt+Shift+L` (Seitenleiste öffnen bzw. in Firefox ein-
und ausblenden) und `Alt+Shift+T` (Seite übersetzen). „Originalseite wiederherstellen“ und
„Seite zusammenfassen“ haben kein Kürzel, du kannst ihnen aber eines zuweisen. Tastenkürzel
änderst du in Chrome unter `chrome://extensions/shortcuts` und in Firefox unter `about:addons`
→ Zahnrad → „Tastenkombinationen für Erweiterungen verwalten“. Ist ein Kürzel schon vom Browser
oder einer anderen Erweiterung belegt, kann es wirkungslos bleiben – dann dort ein anderes wählen.

## Datenschutz

- Einstellungen, API-Schlüssel und die Kostenstatistik liegen in `storage.local` deines
  Browserprofils, Chats in IndexedDB. Nichts davon wird synchronisiert oder hochgeladen.
- Das Guthaben wird nur abgefragt, wenn du **Kosten & Guthaben** öffnest oder im ⋯-Menü der
  Seitenleiste darauf klickst, und zwar direkt beim jeweiligen Anbieter.
- Eine Anfrage geht nur raus, wenn du sie auslöst (Nachricht senden, Aktion anklicken,
  Seite übersetzen). Sie geht direkt an den Anbieter, den du gewählt hast. Was der Anbieter mit
  den Daten macht, regeln dessen Bedingungen.
- Webseiteninhalte werden nur mitgeschickt, wenn du „Seite“ einschaltest oder eine Aktion bzw.
  Übersetzung startest. Die Adresse der Seite geht dabei ohne Suchparameter und Anker (`?…`,
  `#…`) mit, Inhalte von Passwortfeldern und Einmalcode-Feldern nie.
- Unter **Einstellungen → Daten & Datenschutz** kannst du alles exportieren und löschen. Der
  Einstellungs-Export ohne Schlüssel lässt API-Schlüssel und die Werte zusätzlicher HTTP-Header
  weg, enthält aber dein Profil („Über mich“, Schreibstil), Personas und Schnellaktionen.

## Fehlerbehebung

- **„Ungültiger API-Schlüssel“**: Schlüssel neu einfügen, auf Leerzeichen achten, beim Anbieter
  Guthaben prüfen.
- **Netzwerkfehler bei Ollama / LM Studio**: siehe „Lokale Modelle“ oben (`OLLAMA_ORIGINS`
  bzw. CORS).
- **Gemini meldet „403“**: Erstelle in AI Studio einen neuen Schlüssel. Ältere uneingeschränkte
  Schlüssel werden abgelehnt.
- **Werkzeugleiste erscheint nicht**: Auf Browser-internen Seiten (`chrome://`, Web Store,
  addons.mozilla.org) dürfen Erweiterungen nicht laufen. Tabs, die vor der Installation schon
  offen waren, einmal neu laden. In Firefox außerdem den Zugriff auf Webseiten prüfen (siehe
  [Installation](#firefox)).
- **Rotes „!“ am Symbol der Erweiterung**: Eine Aktion aus dem Kontextmenü oder per Tastenkürzel
  konnte auf dieser Seite nicht ausgeführt werden (z. B. geschützte Seite, kein Zugriff, kein
  Anbieter eingerichtet). Fahre mit der Maus über das Symbol, um den Grund zu sehen. Der Hinweis
  verschwindet nach einigen Sekunden.
- **Firefox: „Im Chat fortsetzen“ bzw. „Im Chat fragen“ öffnet die Seitenleiste nicht**: Firefox
  erlaubt das Öffnen nur nach einem direkten Klick auf das Symbol. Ist die Seitenleiste schon
  offen, landet der Chat sofort dort. Sonst zeigt das Ergebnisfenster einen Hinweis: Öffne die
  Seitenleiste über das LLM-Sidebar-Symbol, der Chat wartet dort (bis zu 24 Stunden).

## Entwicklung

```bash
npm test          # Unit-Tests (node:test, ohne Abhängigkeiten)
npm run build     # dist/chrome und dist/firefox bauen
npm run zip       # zusätzlich Zip-Dateien für Chrome Web Store / AMO
npm run icons     # Symbole neu rendern
npm run dev       # Dev-Harness auf http://localhost:8787
```

Die **Dev-Harness** (`npm run dev`) startet die komplette Erweiterung in einem normalen
Browser-Tab, also Testseite, Seitenleiste und Hintergrundskript, mit nachgebildeter
Erweiterungs-API und einem **Mock-KI-Server**. Damit kannst du alles ohne echten API-Schlüssel
ausprobieren. Der Mock reagiert auf Stichwörter in der Nachricht: „denk“ (Gedankengang),
`#langsam`, `#ablehnen`, `#abschneiden` (Längenlimit), `#fehler429` (beliebiger HTTP-Status) und
`#fehlerstream`. `?reset=1` an der Harness-Adresse setzt den nachgebildeten Speicher zurück.

Aufbau und Schnittstellen sind in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) beschrieben,
Übersetzungen der Oberfläche in [docs/I18N.md](docs/I18N.md), die
recherchierten API-Details der Anbieter (Stand November 2026) in [docs/research](docs/research).

```
src/
  background/   Hintergrundskript (Kontextmenü, Tastenkürzel, Anfragen der Webseiten-Werkzeuge)
  content/      Werkzeugleiste, Ergebnis-Fenster und Seitenübersetzung auf Webseiten
  sidepanel/    Chat-Seitenleiste
  options/      Einstellungen
  lib/          gemeinsame Module (LLM-Client, Einstellungen, Prompts, Markdown, Datenbank …)
  styles/       Design-System
  locales/      Texte der Oberfläche, eine Datei pro Bereich und Sprache
manifests/      Manifest-Teile für Chrome und Firefox
scripts/        Build und Symbol-Erzeugung
dev/            Dev-Harness und Mock-Server
tests/          Unit-Tests
```

## Mitmachen & Lizenz

Fehlerberichte, Übersetzungen und Pull Requests sind willkommen, siehe
[CONTRIBUTING.md](CONTRIBUTING.md). Sicherheitslücken bitte vertraulich melden, siehe
[SECURITY.md](SECURITY.md). Lizenz: [MIT](LICENSE).
