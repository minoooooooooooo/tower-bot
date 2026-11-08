# Profile background artwork

The card is generated from `../card.png` (1868 × 1200) and tinted for each
level tier. Real artwork is optional: drop a file here with a tier id as its
name and the renderer uses it instead of the generated treatment.

| File | Level | Design |
|---|---|---|
| `tier-05.png` | 5 | Ember |
| `tier-10.png` | 10 | Verdant |
| `tier-15.png` | 15 | Tide |
| `tier-20.png` | 20 | Amethyst |
| `tier-25.png` | 25 | Rose |
| `tier-30.png` | 30 | Solar |
| `tier-35.png` | 35 | Frost |
| `tier-40.png` | 40 | Void |
| `tier-45.png` | 45 | Prismatic |
| `tier-50.png` | 50 | Celestial |

Rules for the artwork:

- **1868 × 1200** exactly, or the same layout at 2× (3736 × 2400); the
  renderer scales it back to 1868 × 1200.
- Keep the six panels, the title panel and the XP track in the same positions
  as `card.png`. The labels are painted into the art and the renderer only
  draws the values on top.
- Leave the lower-left area fairly open: the member-status block draws light
  glass text directly on the art there.

A custom wallpaper uploaded by a member is drawn at runtime with its own glass
panels, so it does not need to follow these rules.
