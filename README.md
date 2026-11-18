# Tarkov Quest Map

A Windows desktop companion for Escape from Tarkov that:

- **Reads the game's own log files** to find which quests you started, finished, or failed. Nothing is injected into or read from game memory.
- **Detects the map you're loading into** and switches to it automatically.
- **Shows quest locations on the map**: objective zones (diamonds with outlines) and quest-item spots (circles), plus extracts.
- **Shows your position** if you press the in-game screenshot key during a raid. EFT writes your coordinates and facing into the screenshot filename.

- **Plans a raid.** In the **Raid plan** tab, tick the quests you'll do this raid. Then pick a start (a PMC spawn, or your screenshot position) and an extract. The map shows only those quests plus a numbered route. The tab also lists what to bring: keys, items to plant or use, required weapons and gear, quest items you should already carry, and found-in-raid items to watch for.

- **Ammo chart (Ammo tab):** every round, by caliber or by weapon. Shows damage, penetration, armor damage, fragmentation, speed, recoil, accuracy and bleed, plus a 0–6 rating against armor classes 1–6. A "Get it" column shows the cheapest way to buy each round with *your* trader levels, finished quests and flea access. The chart badges the best-penetration round you can get and the round with the most flesh damage.
- **Gunsmith tab:** picks attachments for any weapon to reach the lowest recoil (meta), a balanced build, or the best ergonomics. Choose "What I can get now" (your trader levels, quest unlocks, flea and barters) or "Endgame meta" (everything unlocked). Recoil and ergonomics use the game's formula, checked exactly against all 164 default presets, and respect the 100-ergonomics cap. Conflicting parts are avoided. Optics, lights and lasers are left for you to choose. It also suggests the best ammo you can get for the gun.
- **Item unlocks:** 🔓 marks quests that unlock trader purchases or barters, from the quest rewards plus trader and barter data. ⤳ marks quests whose later chain leads to unlocks. Hover a badge to see the items; the quest Details panel shows them as pictures. All quests has an unlocks filter. Since the 1.0 quest rework, many quests unlock through trader dialogue, so tarkov.dev only links chains for about 200 of 499 quests.
- **Key rooms (🔑 Keys):** shows every locked door and car trunk on the map. Hover shows the key; click shows the key's picture, where to buy or barter for it, and which of your quests need it. Keys needed for your quests get a gold ring.
- **Extracts:** labelled PMC / SCAV / PMC+SCAV, with icons for 🗝️ secret, 🎆 flare, 🤝 co-op, 🚗 V-Ex, 🚂 train, 🧗 cliff and 🛗 elevator extracts. A legend lets you show or hide each side. Hovering shows the extract area; clicking shows requirements (like payment for V-Ex and secret extracts) and links to the wiki's extract photos. tarkov.dev has no extract photos, and its power-switch data is unreliable, so switches aren't shown.
- **Saved builds (Gunsmith):** change any part from a dropdown of compatible parts, or empty the slot. A new part's own attachments are filled in for the chosen goal. Parts that can't be fitted together are flagged ⚠, and parts you can't get yet show 🔒 with what unlocks them. Save as many named builds per gun as you like, then rename, update or delete them. Builds are shared across PvE/PvP, and each one shows recoil and ergonomics in the builds bar.
- **Scav runs:** in **Raid plan**, switch to **Scav run** and tick what you want: 🔫 weapon boxes, 🧨 ammo and grenade boxes, 🦺 bodies (armor, rigs, guns), 💰 safes and PCs, 💊 meds, 🔧 tech crates, 📦 hidden stashes or 🗝️ key spawns. The app groups each map's containers into hotspots (rooms and buildings with the most of what you picked, rarer kinds weighted up) and picks the stops with the most loot per metre walked, from a Scav spawn to a Scav extract. Choose Quick, Normal or Long, or tick spots yourself (or click a dashed **+** on the map). Mark a stop ✓ looted to drop it for this raid. Containers come from tarkov.dev and are fixed spots; their contents are random. tarkov.dev's loose-loot data has no guns, armor or ammo, so those come from boxes and bodies.
- **Loot layer (📦 Loot):** shows the same containers on the map in any filter, coloured by kind, with a legend to pick the kinds. Hover a dot to see what it is; loose spots list the valuable items they can spawn.
- **Boss spawns (💀 Bosses, on by default):** a skull on every spot a boss can spawn. Hover it to see which bosses can appear there, the chance of each, and their guards. Raiders, Rogues, Cultists and the Goons are included.
- **Live position:** press your in-game screenshot key during a raid and an arrow shows where you are and which way you're facing. The arrow direction was checked against 209 pairs of real screenshots and on every map rotation.

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
