# Lode Runner — HD Remaster

A high-resolution browser remake of the 1983 Broderbund classic by Doug Smith, featuring **all 150 original Apple II levels** with authentic mechanics — rebuilt from scratch in vanilla JavaScript and HTML5 Canvas. No frameworks, no build step, no external assets.

![Genre](https://img.shields.io/badge/genre-arcade%20puzzle-f2b632) ![Tech](https://img.shields.io/badge/tech-vanilla%20JS%20%2B%20canvas-3fa7d6) ![Levels](https://img.shields.io/badge/levels-150-4caf7d)

## Play

Open `index.html` in any modern browser — that's it. (Or serve the folder, e.g. `python -m http.server`, and browse to it.)

## Controls

| Key | Action |
|---|---|
| `← → ↑ ↓` or `WASD` | Run, climb ladders, hang from ropes |
| `Z` / `X` | Dig left / dig right through brick floors |
| `P` | Pause |
| `R` | Restart level |
| `M` | Sound on/off |
| `L` | Level select |

## Gameplay

Collect every gold chest in the level, then climb to the top to escape. Guards chase you relentlessly — dig holes in brick floors to trap them (they climb back out, and holes regenerate, crushing anyone still inside). Watch out for **false bricks** you fall straight through, and **hidden ladders** that only appear once all gold is collected. Guards can pick up gold and carry it around; trap them to make them drop it.

- 250 pts per gold · 75 pts per trapped guard · 150 pts per crushed guard · 1,500 pts + 1 life per level
- Progress, high score, and completed levels are saved locally in your browser

## Features

- All 150 original levels, extracted from the Apple II disk image (level data via [SimonHung/LodeRunner](https://github.com/SimonHung/LodeRunner))
- Crisp high-DPI canvas rendering with smoothly animated vector characters
- Classic guard AI: BFS pathfinding with authentic falling/climbing rules, hole trapping, gold carrying, and respawning
- Procedurally generated sprites and WebAudio-synthesized sound effects — zero asset files
- Level select for all 150 levels with completion tracking
- Auto-pause when the tab loses focus

## Files

| File | Purpose |
|---|---|
| `index.html` | Page shell, HUD, and modal system |
| `style.css` | Dark professional theme |
| `game.js` | Engine: physics, digging, guard AI, rendering, UI |
| `levels.js` | All 150 original level grids (28×16) |
| `audio.js` | WebAudio synthesized sound effects |

## Credits

- Original game: Doug Smith / Broderbund (1983)
- Level data: extracted from the Apple II disk image, via the [SimonHung/LodeRunner](https://github.com/SimonHung/LodeRunner) preservation project
- This is a non-commercial fan remake built for personal and educational use

🤖 Generated with [Claude Code](https://claude.com/claude-code)
