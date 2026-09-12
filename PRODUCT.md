# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

**Primary — the first-timer at a demo table.** Someone who has never seen Rally, standing
in front of a display with a phone in their hand and a queue behind them. They have not
read anything, they will not read anything, and their patience is measured in seconds.
Their job is *to be playing*: scan, grant, calibrate, swing. The governing constraint is
that they are swinging within about thirty seconds of walking up, and that nothing in
the path can stall, ask twice, or fail silently.

**Co-equal second — two people playing a real match, remotely.** They already know what
Rally is. They are on different networks, each at their own screen with their own phone,
connected by a four-letter room code or an invite link. Their job is a match that feels
local despite the distance: the ball where they expect it, a rally that ends for a
reason they can name, a score they trust.

Judge-first is a priority order, not an exclusion. Sustained remote play is a real job
and design must not spend it to buy a smoother walk-up.

**Also present:** a spectator. Every match is watched by whoever is standing there, and
the commentary is aimed at the room rather than at the players' ears.

## Product Purpose

Rally is motion-controlled remote multiplayer swing sports with live AI commentary.

Two players, each at their own screen, each holding their own phone like a paddle, on
different networks. They rally. A commentator narrates it — reacting to what actually
happens, citing things the players actually did, coining a nickname early and calling
back to it at match point.

There is no app to install. The phone joins by scanning a QR code shown on the display
it will be playing against.

Success is that a stranger is playing within thirty seconds of arriving, that the match
they then play feels local rather than networked, and that it is commentated whether or
not any API key is configured.

## Positioning

Three things, each of which a neighbouring product could not truthfully claim:

- **The phone is the paddle, and there is nothing to install.** A web page reads the
  device's motion sensors and speaks the same protocol a mouse does — the server cannot
  tell the two apart. Pairing is a QR scan on the display's own screen.
- **Remote play that reads as local, by splitting latency three ways rather than
  averaging it.** Your own paddle is forwarded out of band with zero added delay; the
  ball, opponent and score interpolate 100 ms behind server time; your hit reaction is
  predicted locally and reconciled on the next snapshot. That split is most of what
  makes remote play feel local.
- **A commentator that needs no API keys.** The offline writer and the browser's own
  speech synthesis run the identical three-layer pipeline the paid providers do, so the
  architecture is exercised either way. A demo one expired credential away from silence
  is not a demo.

Supporting the first two: the contact model is deliberately generous where the visuals
are physical. A bad swing still returns the ball; it just returns it somewhere boring.
Rallies end because a player was rushed, not because a die was rolled.

## Operating Context

- **The demo table.** A laptop or iPad shows the court; phones belonging to whoever walks
  up scan the QR code on it. Conference wifi is assumed hostile — client isolation and
  blocked ports are the two ways this class of thing breaks.
- **One TLS origin, non-negotiable.** The display, the phone app and the WebSocket must
  share one HTTPS hostname. iOS grants motion access only over HTTPS, and the QR code is
  built from the origin the display was served from. Over plain HTTP the phone loads,
  refuses the sensors, and explains itself on screen; the lobby says so beside the QR
  code in advance.
- **One tap grants everything.** Motion access, orientation access and a screen wake lock
  must all come from the same gesture, because iOS requires it.
- **A 1.5 second calibration** follows: hold the phone like a paddle, pointing at the
  display. After that the only input is the swing.
- **Three ways to get an opponent,** all offered in the lobby: a bot; a second phone
  scanning the same display (two people, one screen, one room); or another display
  anywhere, reached by a four-letter room code or an invite link.
- **A mouse is a first-class controller,** not a test mock — it opens its own WebSocket
  and speaks the identical protocol, so the whole game is playable with no phone at all.
- **One process, state in memory.** Rooms, live matches and the commentator's narrative
  memory live in the server process. Two replicas put two players in two processes and
  the room is not found; a host that suspends does not pause a match, it deletes one.
  Scaling past one box means moving rooms out of process memory — real work, not config.

## Capabilities and Constraints

**Sports.** Pickleball and badminton share one engine — two courts, two swings, and a
shuttle that never bounces and is met overhead. Table tennis has its own engine: a
regulation 2.74 m table, a ball carrying spin, and a bat with a position you have to put
on the ball. Bowling ships as a compiling, typed, deliberately unimplemented interface
stub, and the lobby lists it as a stub rather than pretending. Pickleball scores
rally-to-seven; table tennis scores the real game, 11 and win by 2.

**Opponents.** A bot on a skill dial (0 helpless, 1 frame-perfect; 0.35 / 0.55 / 0.75 are
easy / normal / hard). Every seat with no phone on it gets a bot, and the Start button
always says which thing it is about to do — *Start match*, *Start vs bot*, *Start — a bot
plays your seat*, *Watch two bots* — because that is not something to discover
afterwards. Start refuses to substitute a bot for a player still calibrating, and says
who it is waiting for.

**Tutorial.** A coached first match against a weak bot, not a sandbox. Every step is
satisfied by the same events and snapshots the scoreboard already reads, so it is a
reading of the live game rather than a second copy of it and cannot drift out of step
with the rules. The checklist is cumulative ("have you done this yet?", never "since I
asked?"), it watches orientation rather than position, and steps have a dwell floor.
Table tennis gets different words throughout, because it has no telegraph ring to point
at.

**Commentary.** Three layers: a cold bank written during the lobby and pushed to displays
as decoded audio before the first serve (at event time the server sends 40 bytes); a
speculative layer that generates every outcome mid-rally and discards the two that did
not happen; and a live layer that runs in the dead time after a point and must cite a
specific fact. It also reacts to *absence* — a serve that is not coming draws a line at
five seconds and a ruder one at nine, both before the simulation serves on the player's
behalf at twelve. The fallback chain is live → speculative → cache → static → silence, so
killing the network mid-match degrades the commentary and never the match.

**Line length is enforced, not requested.** Play is held while the commentator speaks and
that hold is capped, so an over-long line is one the game starts playing underneath. The
prompt asks for four to ten words; an output filter rejects anything over 130 characters.

**Safety.** Player names are user input rendered to audio in front of an audience: they
are sanitised to `[A-Za-z0-9 '-]` and capped at 16 characters. Room codes are drawn from
a 32-character ambiguity-free alphabet (`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`). Generated
lines pass an output filter as well as a prompt ceiling, and **M** mutes instantly.
Secrets live in environment variables and never in a client bundle.

**Budgets that are real.** Server authoritative at 60 Hz, snapshots at 30 Hz, remote
entities interpolated 100 ms behind server time, pose sent at 30 Hz to protect phone
battery and thermals over a long demo day, and a controller bundle of about 25 KB
gzipped because that is what someone waits on while holding a stranger's phone.

**Architectural rules that constrain product changes.** Everything may import `protocol`;
`server` may import `sim`; `controller` may import `motion`; nothing else. `sim` and
`motion` are pure — no fetch, no sockets, no wall clock, no unseeded randomness — which
is what makes them replayable, and is not negotiable. No constant is written twice:
tunable numbers live in `packages/protocol/src/tuning.ts`, and constants that genuinely
differ per sport live on the sport module and resolve per match, because one process runs
many rooms and a table tennis match must not rewrite a pickleball match's strike window.
Live tuning is available on the display (**T**) and pushes to every room immediately.

**Undecided / deliberately unbuilt.** Bowling's `TurnController` is a seam, not a feature.
WebRTC direct pose (the `PoseTransport` seam) is not implemented; server-forwarded pose
is well inside budget. Multi-instance operation is out of scope until rooms leave process
memory. Whether Rally becomes a publicly hosted service with persistent identity is not
decided.

## Brand Commitments

- **The name is Rally.** The phone surface is the Rally Controller.
- **The commentator's voice is short and specific.** Four to ten words, never more than
  130 characters, required to cite something that actually happened. A twenty-word quip
  is not twice as funny as a ten-word one. The offline bank's median line is five words.
- **The project's own writing voice** — README, code comments, UI copy — is declarative
  and reason-giving: it states the decision, then states the obvious alternative that was
  tried first and was wrong. UI copy follows the same rule; the Start button naming what
  it is about to do is that voice in the interface.
- **Nothing in the product may require a key to work.** Configured keys upgrade the same
  pipeline in place; they never gate the experience.

## Evidence on Hand

Real and citable:

- [`README.md`](README.md) — 595 lines covering architecture, the contact model, the shot
  solver, sport authoring, deployment, and a standing "Deviations from the design
  document" section.
- **Measured bot-vs-bot behaviour at shipped defaults, six seeds per sport** — pickleball
  9.0 shots/rally, 186 s, contact 0.63 m; table tennis 2.9 shots/rally, 105 s, contact
  0.99 m; badminton 11.3 shots/rally, 116 s, contact 1.94 m, with the rally-ending
  distributions for each.
- **A test suite** over both physics engines, the shot solver, the spin model, sensor
  fusion, the protocol, the commentary, and full matches over real WebSockets, split into
  a fast set and an end-to-end file.
- **Runnable demonstrations that need no browser:** `npm run headless -- --seed 5` prints
  a whole match as shots, whiffs and points; `npm run replay -- <file> --verify`
  re-simulates a recorded match and diffs it; `npm run mock:snapshots` serves a looping
  match with jitter and packet loss.
- **Working deploy paths** — [`deploy/`](deploy) (Docker Compose + Caddy, TLS issued and
  renewed) and [`fly.toml`](fly.toml).

Absent, and not to be fabricated: there are no users, no testimonials, no case studies,
no press, no benchmarks against other products, no pricing or licensing, no logo or brand
asset files, and no public hosted instance. Rally has not shipped to an audience beyond
demos.

## Product Principles

1. **Nothing may stall.** A demo that will not start is worse than a silent one. Serve for
   the player who waited, degrade the commentary rather than the match, and make every
   failure say what it is — a QR that "just doesn't work" is the least debuggable failure
   there is.
2. **Say what is about to happen, before it happens.** The Start button names its action;
   the lobby warns about HTTPS beside the QR code rather than after the phone fails; a
   copy button says it copied. Surprise is the defect.
3. **Feel is bought with latency budgets, not effects.** Zero delay on your own paddle,
   100 ms on everything remote, prediction reconciled on the next snapshot. Where the
   visuals are physical the contact is generous, because a paddle must never pass through
   empty air while the ball rockets away.
4. **Teach by reading the real game, never by building a second one.** The tutorial, the
   telegraph ring, and the difficulty model all express themselves inside the match that
   is actually being played, so none of them can drift out of step with it.
5. **Degrade, never gate.** No key, no phone, no network, no opponent — each has a path
   that still plays: the offline commentator, the mouse, the fallback chain, the bot.

## Accessibility & Inclusion

Established: commentary is an audio channel aimed at a room, and **M** mutes it
instantly. The display is read from across a room by people who are not sitting at it,
and depth on a 2D screen is carried by the shadow under the ball rather than by the ball
itself.

Undecided, and not to be assumed: there is no caption or transcript surface for the
commentary, no stated conformance target, and no confirmed requirement around motion
sensitivity, colour vision, or one-handed play. Future work should record what it
establishes here rather than inheriting a standard nobody set.
