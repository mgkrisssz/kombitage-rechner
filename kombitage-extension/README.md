# Kombitage

Version v1.1.0

Eigenständige Chrome-Erweiterung: Kombitage-Arbeitszeitrechner mit **read-only SAP Time Events Sync**.
Sie liest dein virtuelles SAP-Terminal im Hintergrund aus und berechnet pro Tag Büro-/Heim-Anteil,
klassifiziert **Bürotag / Kombitag / Telearbeit**, Gleitzeitkonto, Feierabend-Planung und eine
Jahres-Übersicht des Telearbeit-Kontingents. SAP wird **nur gelesen** – es werden nie Stempelaktionen ausgelöst.

## Dateien

- `manifest.json` – Manifest V3
- `background.js` – Service Worker: öffnet das SAP-Terminal im Hintergrund, liest aus, schließt den Tab wieder
- `content-sap.js` – liest die „Auswertung / Time events“-Tabelle aus und paart Clock-in/Clock-out zu Blöcken
- `kombi.html` / `kombi.css` / `kombi.js` – die App (Zeitstrahl, Rechner, Übersicht, Einstellungen)

## Lokale Installation zum Testen

1. Chrome öffnen: `chrome://extensions`
2. Entwicklermodus aktivieren.
3. `Entpackte Erweiterung laden` klicken.
4. Diesen Ordner (`kombitage-extension`) auswählen, in dem `manifest.json` direkt liegt.

## Nutzung

- Extension-Icon öffnet die Kombitage-App.
- **SAP Sync** (oben rechts) liest das virtuelle Terminal im Hintergrund und füllt automatisch mehrere Tage.
  - War kein SAP-Tab offen, wird ein Hintergrund-Tab erzeugt und nach dem Lesen wieder geschlossen.
  - Ist SAP nicht angemeldet/freigegeben, erscheint im Tagesverlauf-Hinweis „🔒 Du bist (noch) nicht in SAP angemeldet …“;
    dort anmelden und erneut Sync klicken.
- **Zeitstrahl**: Blöcke ziehen, Ränder greifen. Per Button **Büro-**, **Heim-** oder **Arzt-Block** einfügen.
  - ⇄ wechselt den Ort zyklisch (Büro → Heim → Arzt), ✎ öffnet die **minutengenaue** Zeit-Eingabe (HH:MM), ✕ löscht.
  - Blöcke rasten minutengenau ein (früher 5-Minuten-Raster).
  - **Arzt** zählt als Arbeitszeit fürs Gleitzeitkonto, wird aber nicht in den Büro-Anteil (Kombitag-Schwelle) eingerechnet.
- **Gleitzeitkonto (rechts)**: zeigt den **hochgerechneten Kontostand**, wenn du jetzt aufhörst
  (SAP GLZ-Saldo + heutiger Beitrag) – groß in Stunden mit Komma, darunter klein in Stunden/Minuten.
- **Datumsleiste**: vor/zurück/Heute – jeder Tag hat seinen eigenen Balken.
- **Übersicht**: zählt Büro-, Kombi- und Telearbeitstage im Jahr und das Rest-Kontingent.
- **⚙️ Einstellungen**: Büro-Schwelle (Standard 51 %), Kontingent, Sollzeit, Normaltag-Länge, Mittagspause + Fenster,
  Live-Auto-Refresh (Intervall) und SAP-URL. Änderungen wirken sofort und werden lokal gespeichert.

## Daten

Alle Tage und Einstellungen liegen lokal im Browser (`localStorage`), es werden keine Daten nach außen gesendet
außer dem read-only Lesezugriff auf das konfigurierte SAP-Terminal.

## Paket für Veröffentlichung erstellen

Den Inhalt dieses Ordners zippen (nicht den übergeordneten Ordner), sodass `manifest.json` direkt im ZIP-Root liegt.
