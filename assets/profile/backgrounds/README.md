# Profile background artwork

The ladder lives in [`backgrounds.json`](backgrounds.json). Each design is drawn
from `../card.png` (1868 × 1200) and tinted with its `theme`; real artwork is
optional and replaces the treatment for that id. The ten tier pictures currently
ship in this folder as `tier-05.jpg` … and `tier-50.png`, and every tier is set
to `"artMode": "wallpaper"`.

## The two art modes

Add `assets/profile/backgrounds/<id>.png` (`.jpg`, `.jpeg` and `.webp` also
work) and set `artMode` on that design in `backgrounds.json`.

| `artMode` | What you supply | What the bot does |
|---|---|---|
| `"template"` (default) | The **whole card**: background plus the six panels, title panel, XP track and labels, exactly where `card.png` has them | Draws only the values on top at fixed positions |
| `"wallpaper"` | A **raw picture only** | Cover-crops it to 1868 × 1200 and draws the glass panels, labels and XP track itself |

So a raw background **is** enough — but only in `wallpaper` mode. In the default
`template` mode a raw picture would leave the panels and labels missing.

```json
{
  "id": "tier-05",
  "name": "Ember",
  "level": 5,
  "artMode": "wallpaper",
  "theme": { "from": "#ff7a1a", "to": "#ffd166", "accent": "#ffb347" }
}
```

`theme` is still required for tier designs even when art is supplied; its
`accent` colours the XP bar. For a raw picture you can keep the theme that
matches the art.

## Rules for `template` art

- **1868 × 1200** exactly (the loader does not scale).
- Keep the six value panels at the positions in `card.png`: rank `622,292`,
  level `1222,292`, vex `622,482`, nightmare `1222,482`, punishments `622,676`,
  behavior `1222,676`, each about `576 × 166`.
- Keep the title baseline at `198` and the XP track at `681,980` size
  `1059 × 49`.
- Leave the lower-left area fairly open: the member-status block draws light
  glass text directly on the art there.

`wallpaper` art has none of those constraints; the bot adds the UI.

## Default designs

| Id | Level | Design |
|---|---|---|
| `tier-05` | 5 | Ember |
| `tier-10` | 10 | Verdant |
| `tier-15` | 15 | Tide |
| `tier-20` | 20 | Amethyst |
| `tier-25` | 25 | Rose |
| `tier-30` | 30 | Solar |
| `tier-35` | 35 | Frost |
| `tier-40` | 40 | Void |
| `tier-45` | 45 | Prismatic |
| `tier-50` | 50 | Celestial |

A custom wallpaper uploaded by a member is always treated as a raw picture and
gets the runtime glass panels.
