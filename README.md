# Tarkov Quest Map

A Windows desktop companion for Escape from Tarkov that:

- **Reads the game's own log files** to find which quests you started, finished, or failed. Nothing is injected into or read from game memory.
- **Detects the map you're loading into** and switches to it automatically.
- **Shows quest locations on the map**: objective zones (diamonds with outlines) and quest-item spots (circles), plus extracts.
- **Shows your position** if you press the in-game screenshot key during a raid. EFT writes your coordinates and facing into the screenshot filename.

- **Plans a raid.** In the **Raid plan** tab, tick the quests you'll do this raid. Then pick a start (a PMC spawn, or your screenshot position) and an extract. The map shows only those quests plus a numbered route. The tab also lists what to bring: keys, items to plant or use, required weapons and gear, quest items you should already carry, and found-in-raid items to watch for.

PvE, PvP and PvP Season each keep separate progress and their own prestige level, the same way the game does. PvE is shown by default. Switch with **Mode** in the top bar, or pick "Follow the game".

- **Prestige:** each prestige resets quest progress. The app finds prestiges in the backend log (`/client/prestige/obtain`), counts only quest events after your latest one, and shows your level (0–6). If you prestiged before your logs begin, set your level in Settings.
- **Wipe:** Settings → Wipe resets the modes you tick as of a date you choose. Progress before that date stops counting, and manual marks and raid plans for those modes are cleared. You can optionally reset prestige to 0. "Undo wipe" brings the old progress back. Game files are never touched.

**Read-only.** The app never writes to, deletes, or locks any game file, log, or screenshot. It doesn't read game memory or touch the game process. Its own data lives only in `%APPDATA%\Tarkov Quest Map`.

## Run it

```bash
npm install
npm start
```

Or build a standalone app:

```bash
npm run package
```

That creates `release/TarkovQuestMap-win32-x64/TarkovQuestMap.exe`. Copy that whole folder wherever you like.

## How it works

| What | Where it comes from |
| --- | --- |
| Install folder | Steam library folders (`HKCU\Software\Valve\Steam`) or the BSG launcher uninstall key; you can override it in Settings |
| Session mode (PvE/PvP) | `application_000.log`: `Session mode: Pve` |
| Current map | `application_000.log`: `scene preset path:maps/<map>.bundle`, then `TRACE-NetworkGameCreate … Location: <map>` |
| Prestige | `backend_000.log`: `<--- Response … /client/prestige/obtain` |
| Raid start/end | `GameStarted`, `Network game matching aborted`, `UserMatchOver` notification |
| Quest started / failed / finished | `push-notifications_000.log`: `ChatMessageReceived` with message type 10 / 11 / 12; the quest id is the first word of `templateId` |
| Your position | Screenshot filenames in `Documents\Escape from Tarkov\Screenshots` (with facing). Occasional `Reason:…, Position:(x, y, z)` lines in `application_000.log` give a rough position (no facing) |
| Keys, plant/marker items, required gear, PMC spawns | tarkov.dev quest and map data (`neededKeys`, `requiredKeys`, `items`, `markerItem`, `usingWeapon`, `wearing`, `spawns`) |
| Quests, zones, item spots, extracts | [tarkov.dev](https://tarkov.dev) static JSON (`json.tarkov.dev/{pve,regular}/…`), cached in `%APPDATA%\Tarkov Quest Map\cache` |
| Map art and projection | tarkov.dev's `maps.json` and SVG/tile maps |

Every past log session is read at startup. After that, the newest session is tailed once per second. Quest events are also saved to `%APPDATA%\Tarkov Quest Map\progress.json`, so your progress survives if EFT cleans up old logs.

### Quest status rules

1. The latest log event for a quest sets its status (started → **Active**, finished → **Completed**, failed → **Failed**).
2. If you started or finished a quest, its prerequisites must have been completed. Those are marked **Completed (inferred)**. The game doesn't always log a hand-in, so this catches the gaps.
3. Anything you set by hand (All quests tab, or a marker popup) overrides both of the above.
4. A quest is **Available** once all its prerequisites are met. If you set your level and faction in Settings, those are checked too.

After a wipe, set **Count progress from (wipe date)** in Settings so older logs are ignored.

## Tests

```bash
npm test
```

`npm run scan` prints what the app detects from your real logs, without opening a window.

## Credits

- Quest, map and position data plus map art: [tarkov.dev](https://tarkov.dev) / [the-hideout](https://github.com/the-hideout). Map projection code is adapted from [the-hideout/tarkov-dev](https://github.com/the-hideout/tarkov-dev) (MIT), and `src/data/maps.json` is a fallback copy of their map config.
- The log formats were learned by reading [the-hideout/TarkovMonitor](https://github.com/the-hideout/TarkovMonitor) (GPL-3.0). No code was copied from it.
- Maps rendered with [Leaflet](https://leafletjs.com) (BSD-2).

Not affiliated with Battlestate Games.
