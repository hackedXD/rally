---
name: Rally
description: Motion-controlled remote multiplayer swing sports, drawn as the court you play on.
colors:
  court: "#00c65a"
  court-alt: "#12d96b"
  kitchen: "#00a24a"
  apron: "#0b49d0"
  apron-deep: "#0a2e8a"
  line: "#ffffff"
  ink: "#04220f"
  ink-blue: "#04143a"
  optic: "#e3ff33"
  chalk: "#e8f0ff"
  flag: "#ff4d2e"
  label-dim: "#9fb2e8"
typography:
  display:
    fontFamily: "Bungee, Archivo, system-ui, sans-serif"
    fontSize: "clamp(30px, 6.1vw, 88px)"
    fontWeight: 400
    lineHeight: 0.84
    letterSpacing: "normal"
  headline:
    fontFamily: "Bungee, Archivo, system-ui, sans-serif"
    fontSize: "clamp(22px, 3vw, 44px)"
    fontWeight: 400
    lineHeight: 1
  title:
    fontFamily: "Bungee, Archivo, system-ui, sans-serif"
    fontSize: "clamp(15px, 1.5vw, 21px)"
    fontWeight: 400
    lineHeight: 1
  body:
    fontFamily: "Archivo, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.45
  label:
    fontFamily: "Archivo, system-ui, sans-serif"
    fontSize: "11px"
    fontWeight: 800
    lineHeight: 1.2
    letterSpacing: "0.14em"
rounded:
  none: "0"
  ball: "50%"
spacing:
  tape: "4px"
  tape-heavy: "9px"
  tight: "10px"
  snug: "14px"
  room: "22px"
components:
  button:
    backgroundColor: "transparent"
    textColor: "{colors.line}"
    typography: "{typography.body}"
    rounded: "{rounded.none}"
    padding: "12px 20px"
  button-hover:
    backgroundColor: "{colors.line}"
    textColor: "{colors.ink-blue}"
  button-primary:
    backgroundColor: "{colors.optic}"
    textColor: "{colors.ink}"
    typography: "{typography.title}"
    rounded: "{rounded.none}"
    padding: "16px 34px"
  button-primary-hover:
    backgroundColor: "{colors.line}"
    textColor: "{colors.ink}"
  half-mine:
    backgroundColor: "{colors.court}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "clamp(16px, 2vw, 30px)"
  half-theirs:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.chalk}"
  half-open:
    backgroundColor: "{colors.apron-deep}"
    textColor: "{colors.chalk}"
  ticket:
    backgroundColor: "{colors.ink-blue}"
    textColor: "{colors.line}"
    rounded: "{rounded.none}"
    padding: "14px 18px"
  callboard:
    backgroundColor: "{colors.optic}"
    textColor: "{colors.ink}"
    rounded: "{rounded.none}"
    padding: "12px 22px"
---

# Design System: Rally

## Overview

**Creative North Star: "The Painted Court"**

The interface *is* the surface you play on. Not an app with a game behind it — a
court, with the interface painted onto it. Choosing a sport repaints the real 3D
court in place; the room is that same court seen from above and split by the net;
the phone is your half of it, in your hand. Nothing floats over the playing
surface that a groundsman could not have painted there.

That produces a system with almost no chrome in it. There is no elevation, because
paint has none. There are no cards, because a region of a court is defined by tape,
not by a shadowed rectangle. Colour arrives at page scale — whole fields of acrylic
green and electric blue that change per sport — rather than as accents scattered on
a neutral. The energy is entirely in the saturation and the scale of the type; the
structure underneath is plain and rectangular and does not move.

The confirmed anti-reference is this project's own previous interface, and it must
not be reintroduced a piece at a time: near-black ground (`#070b14`), translucent
panels with `backdrop-filter: blur`, hairline borders at 10% white, one neon-mint
accent, and a system sans stack. Every one of those is forbidden below.

**Key Characteristics:**

- Flat acrylic paint in two saturated fields per sport, divided only by 5 cm tape
- Square corners everywhere; the only curve in the system is a ball
- Type stencilled onto the surface, not placed on a panel over it
- Optic yellow reserved for the live signal — the ball and what the ball implies
- No shadow, no blur, no glass, no glow, anywhere

## Colors

Municipal court acrylic: two saturated fields, white tape, and one signal colour
borrowed from the ball.

- **`court` #00c65a** — the in-bounds playing surface, and the ground of your own
  side of the net. `kitchen` #00a24a paints the non-volley zone, which is a real
  contrasting field on a real court, not a tint.
- **`apron` #0b49d0** — out-of-bounds, and the world behind everything. It is the
  page ground on both apps and the scene background, so the court floats on one
  uninterrupted field. `apron-deep` #0a2e8a is the unlit version, used for a seat
  nobody has taken yet.
- **`line` #ffffff** — tape. Structural, never type on green (see the rule below).
- **`optic` #e3ff33** — the ball. Reserved; see The Live Signal Rule.
- **`ink` #04220f / `ink-blue` #04143a** — type on light paint, and the ground of
  the two panels the system permits.
- **`flag` #ff4d2e** — the opponent's kit, and genuine failure.
- **`chalk` #e8f0ff` / `label-dim` #9fb2e8** — body and subordinate labels on dark
  fields.

**The White Is Tape Rule.** White on the court green measures **2.28:1**. It is a
perfectly good painted line and an unreadable piece of text. White is therefore
structural only: tape, borders, net. Type sitting on green is `ink` (7.43:1).

**The Ground Decides The Ink Rule.** The apron is not the same colour for every
sport — badminton's is green, where white type fails. Each sport carries the ink
its own grounds can hold: `groundInk` for the apron, `surfaceInk` for the playing
surface, both on `CourtLook` in `apps/display/src/scene/court.ts`. UI reads them as
`--on-ground` and `--on-surface`. Measured: ink on badminton green 7.91:1, white on
pickleball blue 7.30:1, ink on pickleball green 7.43:1.

**The Live Signal Rule.** Optic yellow belongs to the ball and to the three things
the ball's presence implies: the action that starts play, the commentator's live
voice, and the marker for where you are standing. It is never decoration, never a
label colour, and never more than those on one screen.

## Typography

Two faces, both self-hosted from `/fonts/` — no external CDN, because the product
must survive conference wifi and serve from one origin.

- **Bungee** (display) sets every stencilled thing: the sport's name, seat
  numerals, scores, the primary action, the room code. It is a signage face, which
  is what a court name painted at sponsor scale actually is.
- **Archivo** (variable, 400–800) sets specs, status lines, body and labels.

The phone ships **Bungee only**. Body there runs on the system stack: the
controller's gzipped bundle is a budget a judge waits on while holding somebody
else's phone, and a second webfont buys nothing at arm's length.

**Sponsor scale is measured, not guessed.** The court is a trapezoid in
perspective, so the headline is sized and positioned to fit *inside* the sidelines
at the height it sits. Type that overhangs the lines lands on the apron, where
court ink measures 2.33:1.

## Layout

The design target is a laptop or iPad in landscape, read from across a room, plus a
portrait phone held at arm's length.

- **Nothing covers the court.** The rack is drawn on the live 3D scene with no
  panel over it. Only two painted panels are sanctioned on the playing surface: the
  spec ticket and the caption plate. Controls that need contrast go to the header
  strip, which is always apron.
- **The room is a court from above**: `1fr auto 1fr`, two halves either side of a
  real net column, with the primary action across the net line.
- Breakpoints at **1100px** (the commentary board clears the mouse panel) and
  **900px** (the net lies across the court instead of down it).
- `--tape` 4px and `--tape-heavy` 9px are the only two line weights. A third would
  stop reading as tape.

## Elevation & Depth

**There is none, and that is the system.** No `box-shadow` on any surface, no
`backdrop-filter`, no translucency, no glow. Depth is carried by flat tonal
layering — a darker painted field, a tape edge, a change of ground — and in the 3D
scene by the ball's own cast shadow, which is what lets a player judge height on a
2D screen.

The two permitted "panels" (spec ticket, tuning panel) are painted plates with a
tape border, not lifted cards. Declare one or the other: a border under a shadow is
the ghost card this system has no room for.

## Shapes

`border-radius: 0` everywhere. Court paint has square corners, so buttons, plates,
fields, badges and seat halves do too.

**The only circle is a ball**, or a thing that is literally round on a court: the
wordmark's ball, the phone's tap target, the timing ring, a status light, the kit
swatch's opposite (a square, deliberately). A list bullet is not round here.

Empty states are drawn as the unlit version of what will fill them — a seat nobody
has taken is that half of the court in `apron-deep` behind dashed tape, not a blank
box.

## Components

- **Primary action** — optic field, ink type, Bungee, square. Exactly one per
  screen. It always names what it is about to do (`Start vs bot`, `Watch two
  bots`), because a button that surprises you is the defect.
- **Secondary button** — transparent with 4px tape, uppercase Archivo; inverts to
  white-on-ink-blue on hover.
- **Seat half** — your side `court` green with ink; their side `ink-blue` with
  chalk; unclaimed `apron-deep` with dashed tape. Carries a kit swatch.
- **Kit swatch** — a 15px square, `line` for you and `flag` for your opponent,
  carrying the one identity rule the whole app shares from the scoreboard onto the
  court. Never recolour the 3D players to the paint fields: green players on a
  green court are invisible, and the paint means *which side of the net*, not
  *which player*.
- **Spec ticket** — ink-blue plate, `label-dim` labels against `line` values, real
  numbers read from the sport module. It travels with its sport into the match.
- **Callboard** — optic plate carrying the commentator. It needs no label saying
  whose voice it is; nothing else ever appears there.
- **Icons** — drawn, one 2.4px stroke on a 24 unit box, square caps. Never emoji.

## Do's and Don'ts

**Do**

- Let a whole field of paint carry the colour; change grounds per sport.
- Read the ink off the ground you are painting on, not off a global token.
- Put a control that needs contrast on the apron, or give it its own plate — never
  lay a plate over the playing surface to win a contrast check.
- Theme the browser's own surfaces from the palette: selection, caret, focus ring,
  scrollbars, `accent-color`, tabular numerals.
- Draw progress with `transform: scaleX()`. Bars here are written every frame.

**Don't**

- Don't set white type on the court green, at any size.
- Don't add a shadow, a blur, a gradient on type, or a rounded card. Any one of
  them is the anti-reference coming back.
- Don't put a kicker or eyebrow above a heading. The heading carries itself.
- Don't spend optic yellow on anything that is not the live signal.
- Don't hide a control behind `:hover` — the design target includes an iPad.
- Don't introduce a third tape weight, or a radius that is not a circle.
