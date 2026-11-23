# Profile background artwork

The ladder lives in [`backgrounds.json`](backgrounds.json). Each design is drawn
from `../card.png` (1868 × 1200) and tinted with its `theme`; real artwork is
optional and replaces the treatment for that id. The ten tier pictures ship in
this folder as `tier-05.jpg` … and `tier-50.png`, and every tier is set to
`"artMode": "wallpaper"`.

The bundled manifest now holds **11 free designs** (كلاسيكي plus the ten tiers)
and **50 shop designs** (`bg-01-sakura-dusk` … `bg-50-pearl-sea`). All 50 use
`artMode: "wallpaper"`, a generated `theme` from their palette, and a price from
60 to 360 coins. Paid designs are sold as `design:<id>`; they never auto-equip
and require a purchase even at level 99.

## The two art modes

Add `assets/profile/backgrounds/<id>.png` (`.jpg`, `.jpeg` and `.webp` also
work) and set `artMode` on that design in `backgrounds.json`.

| `artMode` | What you supply | What the bot does |
|---|---|---|
| `"template"` (default) | The **whole card**: background plus the six panels, title panel, XP track and labels, exactly where `card.png` has them | Draws only the values on top at fixed positions |
| `"wallpaper"` | A **raw picture only** | Cover-crops it to 1868 × 1200 and draws the glass panels, labels and XP track itself |

So a raw background **is** enough — but only in `wallpaper` mode. In the default
`template` mode a raw picture would leave the panels and labels missing.

The bundled `card.png` ships **without** any label text; the renderer draws the
Arabic labels (`العنوان`, `الكوينز`, `المستوى`, …) itself at fixed positions.
`template` artwork is expected to bring its own labels, because the renderer
only adds values to authored cards.

```json
{
  "id": "tier-05",
  "name": "جمر",
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
- **Draw your own panel labels** (about 24 px, at `panel.x + 44`,
  baseline `panel.y + 56`): the bundled template no longer has any, and the
  renderer only adds the Arabic labels to that template, not to authored art.
- Keep the title baseline at `198` and the XP track at `681,980` size
  `1059 × 49`.
- Leave the lower-left area fairly open: the member-status block draws light
  glass text directly on the art there.

`wallpaper` art has none of those constraints; the bot adds the UI.

## Paid designs

An entry with `"price": 250` is not part of the free ladder: it never
auto-equips, `/background set` refuses it until it is bought, and the store
lists it as `design:<id>` for that many coins. `"auto": false` is implied by a
price. Buying it writes a purchase row, so the unlock survives restarts and
point corrections. Remove the `price` to take a design off sale again; members
who already bought it keep it.

## Editing from the Activity

A **Manage Server** member can use the Activity store → **Backgrounds**:

- **Add background** uploads a picture, sets a name and price, and writes a new
  entry to `data/backgrounds.json` plus `data/backgrounds/<id>.jpg`.
- **Edit** changes the name, price, level or artwork of an existing design.
- **Delete** hides a bundled design with `{ "id": "...", "deleted": true }` in
  `data/backgrounds.json`, or removes an uploaded design and its art. Members
  still using it fall back to كلاسيكي.

`data/backgrounds.json` is an **overlay**, not a replacement: entries merge over
the bundled manifest by id, new ids are appended, and `deleted: true` hides a
bundled entry. `data/backgrounds/<id>.<ext>` wins over a file in this folder, so
a replaced design is picked up without a restart. Uploads are cover-cropped to
1868 × 1200 and stored as JPEG. `data/` is the persistent folder; the bundled
files stay untouched for a restore.

The store does not load the full artwork for every card. If a
`<id>-thumb.jpg` (480 × 270) exists it is used for the grid and sheet; the
profile renderer still uses the full file. The bundled designs ship with
thumbnails, and an Activity upload generates one automatically.

## Default designs

| Id | Level | Design |
|---|---|---|
| `tier-05` | 5 | جمر |
| `tier-10` | 10 | مروج |
| `tier-15` | 15 | مدّ |
| `tier-20` | 20 | جمشت |
| `tier-25` | 25 | ورد |
| `tier-30` | 30 | شمسي |
| `tier-35` | 35 | صقيع |
| `tier-40` | 40 | فراغ |
| `tier-45` | 45 | طيف |
| `tier-50` | 50 | سماوي |

A custom wallpaper uploaded by a member is always treated as a raw picture and
gets the runtime glass panels. Any size from 64 x 64 up to 6000 px per side is
accepted. An animated GIF is normalised to 800 x 514 (up to 16 frames / 6
seconds) and rebuilt under those panels, so it keeps moving on the card;
anything the renderer cannot animate falls back to the first frame.
