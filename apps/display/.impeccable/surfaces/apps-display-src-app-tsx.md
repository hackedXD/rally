---
version: 1
slug: "apps-display-src-app-tsx"
primary_target: "apps/display/src/App.tsx"
related_targets: ["apps/controller/src/main.ts","apps/display/src/styles.css","apps/controller/src/style.css"]
---

# Surface brief — Rally front end

## Scope

Every surface a person looks at: the display's sport carousel, the room (VS) screen,
the match HUD, the end card and tutorial overlay, the live 3D court, and the phone
controller. Visitor mode: **Experience** — the visitor is inside the game, and the
interface recedes into it.

## Audience and job

A first-timer at a demo table, standing, phone in hand, queue behind them: scan, pair,
swing, inside thirty seconds. Co-equal: two people on different networks playing a real
match. A spectator is always watching. See PRODUCT.md.

## Constraints that bind the design

One TLS origin (no external CDNs — fonts are self-hosted). Phone bundle budget is real:
the controller ships one webfont, not two. Nothing may stall; every state says what it
is waiting for. Start must keep naming the action it is about to take. Bowling stays
labelled a stub. Names are 16 chars, sanitised; room codes are 4 chars from an
ambiguity-free alphabet. Commentary is audio with a 130-character ceiling, muted by M.

## Direction contract

**THESIS:** Rally's front end *is* the court surface, not an app drawn on top of a game.
It refuses the arrangement both the incumbent and every browser game ship: translucent
panels, hairline borders and one glowing accent floating over near-black.

**OWN-WORLD:** Flat acrylic court paint in two saturated fields — bright green in-bounds,
electric blue apron — divided only by 5cm white tape. Optic yellow is the single live
signal and belongs to the ball. Deep court ink for type on paint. Bungee sets every
stencilled headline, seat numeral and score; Archivo sets specs and body. A "card" is a
taped region of paint, never a rounded rectangle with a shadow. No blur, no glass, no
glow. Empty states are ghost-stencilled outlines of what will fill them, never blank
boxes.

**STORY:** A stranger sees a court before they see an interface, understands the phone in
their hand is the paddle, scans the code taped inside their own half of the court, and
swings.

**FIRST VIEWPORT:** The live 3D court fills the frame with no panel over it. The sport's
name is stencilled across the playing surface at sponsor scale in Bungee, with its true
spec ticket — court length, net height, contact height, scoring — taped at the lower
left in Archivo small caps. Adjacent sports crop in at both edges as the next court in
the row. The primary action is the carousel itself: moving it **re-stripes the real 3D
court in place** — lines redraw, the paint fields cross-fade, the net changes height — so
nothing on screen is a picture of a court, it is the court about to be played on. The
room screen that follows is that same court seen top-down, split by the net into two
painted halves: one card per seat, each holding its seat numeral, its player, and while
empty its own QR taped at centre reading SCAN TO TAKE THIS SIDE. Start sits on the net
line.

**FORM:** Court Lines — candidate 1 of my ordered grounded list, chosen by the user over
the roll's assigned candidate 5 (sporting-goods packaging). Seed key 1b98af0e, direction
scope, experience mode, code-led.

**FINISH:** unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Memorable moment

The carousel repaints the court you are standing in front of. Pickleball's lines slide
into badminton's, the surface goes green to blue, the net rises — live, in 3D, behind a
UI that never covers it.

## Disciplines carried from the challengers

Designed absence (an empty seat is a ghost-stencilled half-court, not a blank card); a
strict unit grid (tape weight and paint fields snap to one unit and scale in whole
steps); form invention per readout (rack, VS court, scorebug and end card are different
court artifacts, not one component reused); the spec ticket travels with its sport from
carousel to HUD.

## Unresolved

No caption or transcript surface for commentary (PRODUCT.md records this as undecided);
this build does not add one.
