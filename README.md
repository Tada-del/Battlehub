# Clash of Banners

A real-time troop battle game built with vanilla HTML5 Canvas — no frameworks, no build step.

Deploy Swordsmen, Archers, Knights, Pikemen, Mages, Healers, and Giants on the battlefield and crush the enemy castle.

## Play

Just open `index.html` in any modern browser, or use the public link added to the PR description.

### Controls

- Click on your half of the battlefield to deploy the selected troop
- `1` – `7`: select troop
- `Space`: pause / resume
- `R`: restart battle

### Modes

- **Play vs AI** — Pick a side, AI controls the other.
- **Sandbox** — Place troops on either side and watch them duke it out.

## Troop balance (rock-paper-scissors)

| Troop | Cost | Best at | Weak to |
|---|---|---|---|
| Swordsman | 50 | Frontline, beats Archers | Knights |
| Archer | 80 | Picking off ranged | Cavalry |
| Knight | 150 | Charging Swords | Pikemen |
| Pikeman | 100 | Anti-Knight | Archers |
| Mage | 180 | AoE vs swarms | Archers |
| Healer | 120 | Sustain behind line | Anything if exposed |
| Giant | 300 | Massive HP soak | Pikemen + Archer combo |

## Tech notes

- Single-file engine (`game.js`), ~700 lines, ~60fps with 200 units thanks to:
  - Cached background and castle sprites
  - Spatial hashing grid (60px cells) for target acquisition + separation
  - Simple object pools / in-place removal
  - DPR-aware canvas scaling, no per-frame allocations in hot loops where avoidable
- Pure DOM/CSS UI in `styles.css`
