# Rally

**Motion-controlled remote multiplayer swing sports, with live AI commentary.**

Two players, each at their own screen, each holding their own phone like a paddle.
They are on different networks. They rally. A commentator narrates it — reacting to
what actually happens, citing things the players actually did, coining a nickname
early and calling back to it at match point.

No app install. The phone joins by scanning a QR code on its own display.

```bash
npm install
npm run dev          # server + display + phone, one command
```

Then open <http://localhost:5173>, hit **Play here (mouse)**, and **Start vs bot**.
That plays the whole game with a mouse — no phone required. For the real thing, see
[Playing with a phone](#playing-with-a-phone); for an opponent who is not a bot,
[Playing another human](#playing-another-human).

---

## What is here

| | |
|---|---|
| **Sports** | Pickleball, table tennis and badminton, sharing one code path — three different courts, three different swings. Bowling ships as a compiling interface stub — see [Adding a sport](#adding-a-sport). |
| **Controllers** | An iPhone held like a paddle, or a mouse. Both speak the identical protocol; the server cannot tell them apart. |
| **Opponent** | Another human across the internet, or a built-in bot with a difficulty dial. |
| **Commentary** | Works with no API keys at all. Add a Gemini key and an ElevenLabs key and the same pipeline upgrades in place. |
| **Tests** | 99 covering the physics, the shot solver, sensor fusion, the protocol, the commentary, and a full match over real WebSockets. |

---

## Quick start

```bash
npm install
npm run dev
```

| | |
|---|---|
| Display | <http://localhost:5173> |
| Phone app | <http://localhost:5173/c> (proxied from the display, which is where the QR points) |
| Health | <http://localhost:8787/healthz> |

**Play right now, with a mouse:** open the display → **Play here (mouse)** →
**Start vs bot**. Move the mouse to aim, hold click (or <kbd>space</kbd>) to wind
up, release to swing. <kbd>Enter</kbd> serves.

The **Start** button always says what it is about to do — *Start match*, *Start vs
bot*, *Start — a bot plays your seat*, *Watch two bots* — because every seat with
no phone on it gets a bot, and that is not something to discover afterwards.

**Watch the simulation with no browser at all:**

```bash
npm run headless -- --seed 5
```

That prints a whole match as a stream of shots, whiffs and points. If it is not
fun to read, no amount of shaders would have saved it.

---

## Playing with a phone

Two things have to be true, and they fail in different ways:

- **The phone has to be able to reach the server.** A QR code encoding
  `http://localhost` sends the phone to its *own* localhost, which shows a blank
  screen with no error. When the display is on the same machine as the server,
  Rally therefore points the QR at this machine's LAN address instead, so a phone
  on the same wifi can load the page.
- **iOS grants motion access only over HTTPS.** Over plain HTTP the phone will
  load the page and then refuse the sensors, with an on-screen explanation. The
  lobby says so next to the QR code.

So for the real thing:

```bash
npm run build                       # build the display and phone bundles
npm run tunnel                      # starts cloudflared or ngrok
RALLY_PUBLIC_ORIGIN=https://your-tunnel.example npm run serve
```

Then open the tunnel URL on a laptop, and scan the QR code with a phone. The phone
shows one button; tapping it grants motion access, orientation access and a screen
wake lock in a single gesture — iOS requires all three to come from the same tap.

Without a tunnel the QR still works well enough to see the app: the phone loads,
shows the gate, and explains that it needs HTTPS for the sensors.

A 1.5 second calibration follows: hold the phone like a paddle, pointing at your
display. After that the only input is the swing.

---

## Playing another human

There are three ways to get an opponent, and the lobby offers all of them.

**A bot.** *Add bot* fills the empty seat. Skill 0.55 by default; the tuning panel
(<kbd>T</kbd>) moves it.

**Two phones, one screen.** While nobody else has claimed seat 2, the lobby shows
a *second* QR code beside the first. Two people scan one display, stand next to
each other, and play across the same rendered court. Everything is still
server-authoritative — the two phones are simply both talking to the same room.

**Two machines, anywhere.** The lobby shows a room code and an invite link.

```
https://your-tunnel.example/?room=7KQP
```

Send it, or have them type the four-letter code into **Or join their room**. Their
display takes seat 2 and shows its own QR for its own phone. Each display forwards
its own player's paddle straight back to them with no added delay, and interpolates
everything else 100 ms behind server time — that split is most of what makes remote
play feel local.

The second seat's QR disappears from the host's screen the moment another display
claims it. Pair tokens are single-use, so a code advertised in two places fails on
whichever scan arrives second, and a QR that "just doesn't work" is the least
debuggable failure there is.

Once both phones are paired the match starts by itself; nobody has to press
anything. And **Start** will not quietly substitute a bot for a player who is still
calibrating — it refuses, and says who it is waiting for. Your *own* seat is fair
game: pressing Start with no phone paired is how you ask to watch two bots play.

---

## AI commentary

Rally ships a commentator that needs **no API keys**. A demo one expired
credential away from silence is not a demo.

| | Default (no keys) | With keys |
|---|---|---|
| Writing | Template writer driven by the live match narrative | Gemini |
| Voice | The browser's own speech synthesis | ElevenLabs |

Both paths run the identical three-layer pipeline, so the architecture is exercised
either way:

- **L0 — cold bank.** Written during the lobby and pushed to every display as
  decoded audio before the first serve. At event time the server sends 40 bytes:
  `CUE_PLAY{id}`. Perceived latency is one network hop.
- **L1 — speculative.** Mid-rally, the outcome space is small — A wins, B wins, or
  it goes long. Generate all three before it happens, play the one that lands,
  discard the rest. Two thirds are thrown away, which is the correct trade.
- **L2 — live.** Runs in the dead time after a point, where 1.5 seconds is free.
  Gets the full narrative and is required to cite a specific fact.

To use the real APIs:

```bash
cp .env.example .env      # add GEMINI_API_KEY and ELEVENLABS_API_KEY
npm run dev
```

The boot banner says which stack is live. `RALLY_FORCE_OFFLINE_AI=1` pins the
offline path for rehearsal, and the fallback chain
(live → speculative → cache → static → silence) means killing the network
mid-match degrades the commentary and never the match.

**Safety.** Player names are user input rendered to audio in front of an audience,
so they are sanitised to `[A-Za-z0-9 '-]` and capped at 16 characters. Generated
lines pass an output filter as well as a prompt ceiling, and <kbd>M</kbd> mutes the
commentator instantly.

---

## How it works

```
                     ┌────────────────────────────────┐
                     │        RALLY SERVER            │
                     │  (Node, single process)        │
                     │                                │
   phone ── WSS ─────┤  SessionManager (rooms, seats) │
   (controller)      │  NetLoop      (60 Hz tick)     │───── WSS ──── laptop
                     │  Simulation   (@rally/sim)     │              (display)
                     │  EventBus                      │
                     │  CommentaryDirector ───────────┼──> Gemini
                     │       │                        │──> ElevenLabs
                     │       └── CueStore (audio)     │
                     └────────────────────────────────┘
```

The server is authoritative at 60 Hz and broadcasts snapshots at 30. Three
different latencies coexist on screen, and getting the split right is most of what
makes remote play feel local:

| Entity | Source | Added delay |
|---|---|---|
| Your paddle | `LOCALPOSE`, forwarded out of band, 3-sample smoothing | zero |
| Ball, opponent, score | Snapshot buffer, interpolated 100 ms behind server time | 100 ms |
| Your hit reaction | Predicted locally, reconciled by the next snapshot | zero, then corrected |

### The contact model

The paddle you see is physical. The hit you get is generous.

1. **Predict.** As soon as the ball crosses the midline, integrate forward to find
   the exact moment and place it will meet the receiver. Published in the snapshot
   so the display can draw a ring that closes on it. Computed **once per shot** —
   a `tIdeal` that drifts by 20 ms makes timing feel random, and it does not have
   to, because the physics is deterministic.
2. **Score the swing** on timing and aim.
3. **Blend intent with assistance.** A bad swing still returns the ball; it just
   returns it somewhere boring.
4. **Reconcile the visuals.** On a hit, the paddle is driven through the real
   contact point over 90 ms and blended back over 120. The player's hand was
   probably 20 cm off, and the screen must never show a paddle passing through
   empty air while the ball rockets away.

### Difficulty, and why rallies end

Players auto-position, so the game cannot express "hard to reach". It expresses the
same thing as **hard to time**: pace, ground covered and an awkward contact height
combine into a difficulty value that tightens the strike window and lowers the
quality ceiling. The display draws the telegraph ring thinner as it rises, which is
the entire tutorial.

A hard ball met with a poor swing then produces **pressure**, which does two
things: it scatters the placement, and it takes away the game's latitude to find a
trajectory that works. That is why balls go wide and catch the tape — because the
player was rushed, not because a die was rolled. Without it, returning is automatic
and every rally runs to forty shots.

### The shot solver

A shot is determined by where it should land, how high it crosses the net, and
gravity. Fit a trajectory through those and the speed falls out — which is why a
dink is never accidentally a rocket.

A pickleball decelerates at roughly 8 m/s² at rally pace, comparable to gravity, so
a drag-free parabola is wrong in two ways at once: it lands short and it crosses
the net lower than asked. The solver corrects both against the same integrator the
match loop runs, so the clearance it promises is the clearance the ball gets.

---

## Layout

```
packages/
  protocol/     THE CONTRACT. Types, Zod schemas, tuning, clock, maths.
  sim/          Pure simulation. No I/O, no clock, no unseeded randomness.
  motion/       Pure sensor fusion and swing detection. Testable offline.
apps/
  server/       Fastify + ws + rooms + net loop + commentary
  controller/   Phone web app (vanilla TS, 23 KB gzipped)
  display/      Laptop/iPad web app (React Three Fiber)
tools/
  mocks/        Stand-ins for every workstream, emitting real protocol messages
  replay/       Record and replay matches deterministically
tests/          Unit, integration and end-to-end
```

**Cross-package imports:** everything may import `protocol`; `server` may import
`sim`; `controller` may import `motion`. Nothing else. If you need something from
another workstream, it goes in `protocol`.

**`sim` and `motion` are pure.** No `fetch`, no `WebSocket`, no `Date.now()`, no
`Math.random()` without an injected seed. Time and randomness are parameters. That
is what makes them unit-testable and replayable, and it is not negotiable.

**No constant is written twice.** If it is a number that might change, it lives in
[`packages/protocol/src/tuning.ts`](packages/protocol/src/tuning.ts). Constants
that genuinely differ between sports live on the sport module and are resolved
per-match — the server runs many rooms in one process, and a table tennis match
must not rewrite a pickleball match's strike window.

---

## Tuning

Press <kbd>T</kbd> on the display for live sliders over every constant, pushed to
the server over the same WebSocket and applied to every room immediately.

The three that matter most:

| Constant | Effect |
|---|---|
| `shot.flightScale` | Global pace. Raise it and rallies become readable; lower it and the game gets frantic. |
| `strike.hardWindowScale` | How much a hard ball tightens the strike window. The rally-decay knob. |
| `bot.skill` | 0 is helpless, 1 is frame-perfect. 0.35 / 0.55 / 0.75 are easy / normal / hard. |

Bot-vs-bot, at the shipped defaults:

| | Match | Rally | Errors |
|---|---|---|---|
| Pickleball | ~110 s | 4.6 shots | whiffs, net, out, unreturned |
| Table tennis | ~78 s | 3.6 shots | ditto, faster |

---

## Adding a sport

One file. Pickleball and table tennis differ only in constants and scoring, and run
the same code path:

```ts
export const tabletennis: SportModule = {
  id: 'tabletennis',
  court:   { length: 7.2, width: 3.3, netHeight: 0.34, ... },
  ball:    { radius: 0.05, restitution: 0.86, dragK: 0.042, ... },
  strike:  { windowMs: 115, contactHeight: 0.34, flightScale: 0.6, ... },
  scoring: rallyToSeven,
  persona: { energy: 0.95, jargon: ['chop', 'loop', 'the pips'] },
  classifyEvents: rallyEvents,
};
```

**Badminton is where that stopped being enough**, and it is the more useful example
because of it. Two of its differences are not numbers:

- **The shuttle never bounces** (`ball.bounces: false`). Every other sport lets the
  ball land once and be returned; here the first thing it touches ends the rally,
  in for the hitter or out for the receiver.
- **It is met above the head.** `contactHeight` is 1.95 m against pickleball's
  0.78 — above the net rather than below it, which is why the smash is badminton's
  default attacking shot and not a rare one. `reachHeight` had to become per-sport
  so an overhead is reachable at all.

Between them those forced a third branch in the contact model. The other two
sports let the receiver stand near their baseline and wait, because anything short
bounces back up to them; a shuttle does not, so the receiver has to go and meet it
in the air — and then the question is *where*, since every point on the descent is
a legal contact. They meet it at the point that costs them least: distance to run,
traded against how awkward the contact height is
(`TUNING.strike.contactComfortBias`). Take the first legal contact instead and both
players end up crowded on the net playing a thirteen-metre sport in two metres.

Bowling is the other honest test: it is not rally-based, so it cannot route through
the rally loop at all. [`packages/sim/src/sports/bowling.ts`](packages/sim/src/sports/bowling.ts)
ships the `TurnController` seam it would hang from — typed, compiling, and
unimplemented on purpose. The lobby lists it as a stub rather than pretending.

### How the three play

Bot against bot at skill 0.55, six seeds each:

| | shots/rally | match | contact | rallies end on |
|---|---|---|---|---|
| Pickleball | 8.5 | 215 s | 0.64 m, below the net | net 49%, double bounce 42%, out 9% |
| Table tennis | 5.6 | 99 s | 1.17 m, just over the net | net 60%, out 40% |
| Badminton | 9.7 | 107 s | 2.07 m, three quarters overhead | grounded 61%, net 38% |

Badminton is deliberately the most forgiving of the three on timing and aim. A
shuttle is met anywhere between the ankles and full stretch overhead, which needs
more latitude than a ball arriving at a fixed height on a table — and too little
of it reads as overheads that never register.

---

## Commands

| | |
|---|---|
| `npm run dev` | Server, display and phone together |
| `npm run check` | Typecheck everything, then run every test |
| `npm run headless -- --seed 5` | Watch a match as console output |
| `npm run headless -- --sport badminton --skill 0.8` | …with a different sport and bot skill |
| `npm run mock:snapshots` | Serve a looping match with jitter and packet loss |
| `npm run mock:events` | Print the scripted 90-second commentary fixture |
| `npm run echo` | A WebSocket that echoes, for building the phone with no server |
| `npm run replay -- <file> --verify` | Re-simulate a recorded match and diff it |
| `npm run serve` | Build, then serve everything from the Node server |

Set `RALLY_RECORD=1` to write every match to `replays/` as JSONL.

---

## Deploying

Everything runs over WSS on 443 to **one origin**, which is both a requirement and
a convenience. The QR code a phone scans is built from the origin the display was
served from, and iOS grants motion sensors only over HTTPS — so the display, the
phone app and the WebSocket must share one TLS hostname or pairing cannot work.
Serving all three from the Node process is what makes that true, and it sidesteps
the two ways conference wifi breaks this sort of thing (client isolation and
blocked ports).

### One instance, on purpose

Rooms, live matches and the commentator's narrative memory live in this process's
memory. **Do not run two replicas and do not let the host suspend the machine.**
Two replicas put two players in two processes and the room simply is not found;
a suspend does not pause a match, it deletes one — and it would do it during the
idle seconds of a lobby, which is exactly when somebody is waiting for a friend to
scan a code.

This is also why the cheapest free tiers are a poor fit: most of them idle down,
and for an app that keeps its state in memory that is not a slow first request,
it is a deleted match. The Compose setup below restarts on boot and never
suspends; `fly.toml` sets `auto_stop_machines = false` for the same reason.

Scaling past one box means moving rooms out of process memory. That is a real
piece of work, not a config change.

### Vultr (or any box you own)

The best fit for this, because the one thing Rally needs from a host is to *stay
running*: no sleeping on idle, no suspending between matches, and a CPU that is
actually yours for a 60 Hz tick. A **$6/mo High Frequency instance, 1 GB, in New
Jersey** covers US East comfortably.

[`deploy/`](deploy/vultr) has the whole thing: the app and Caddy in one
Compose file, TLS issued and renewed automatically.

```bash
# once, on a fresh Ubuntu 22.04+ instance
ssh root@<ip> 'bash -s' < deploy/provision.sh

# then, from here, as often as you like
deploy/deploy.sh root@<ip>
```

`provision.sh` installs Docker, adds 2 GB of swap (the display bundle is built on
the box and peaks past what 1 GB has free — without swap the OOM reaper kills it
and reports only `exit code 137`), opens the firewall on the SSH port it detects
rather than assuming 22, and writes a starter `.env`. `deploy.sh` rsyncs the
working tree — including uncommitted changes, which is what you want when chasing
something that only happens over a real network — rebuilds, and waits for health.

**You need a hostname, not just an IP.** Let's Encrypt will not issue for a bare
address, and without a certificate iOS refuses the motion sensors. If you have a
domain, point an `A` record at the box and set `RALLY_DOMAIN`. If you don't,
`provision.sh` defaults to [sslip.io](https://sslip.io), which resolves
`45-76-12-34.sslip.io` to `45.76.12.34` with no DNS setup at all and which
Let's Encrypt will happily certify:

```bash
# /opt/rally/deploy/.env
RALLY_DOMAIN=45-76-12-34.sslip.io
GEMINI_API_KEY=...
ELEVENLABS_API_KEY=...
```

That file lives only on the server — `deploy.sh` excludes it in both directions,
so a laptop can never overwrite production secrets or drag them back.

```bash
ssh root@<ip> 'cd /opt/rally/deploy && docker compose logs -f rally'
curl https://<your-domain>/healthz
```

### Fly.io

[`fly.toml`](fly.toml) is here too, if you would rather not run a box.

```bash
fly launch --no-deploy --name rally-<something-unique> --region iad
fly secrets set GEMINI_API_KEY=... ELEVENLABS_API_KEY=...
fly deploy && fly scale count 1
```

Pick a name nobody has taken — the one in `fly.toml` almost certainly is, and
`fly launch` fails obscurely on that. Keep `auto_stop_machines = false` if
`fly launch` rewrites the file.

### Anywhere else

```bash
npm run build
RALLY_SERVE_STATIC=1 RALLY_PUBLIC_ORIGIN=https://your.host npm start
```

Behind your own TLS terminator, forward `x-forwarded-proto` — without it the
server assumes plain HTTP (it never guesses `https` from a hostname, because a
wrong guess hands out a QR code that cannot connect at all) and hands phones a
URL their sensors will refuse.

Secrets live in environment variables and never in a client bundle. See
[`.env.example`](.env.example). Nothing needs a key: without them the offline
writer and the browser's own voice take over.

---

## Deviations from the design document

- **npm workspaces, not pnpm.** Functionally equivalent here, and one fewer thing
  to install. Swap it back by replacing the `"*"` workspace dependency versions
  with `"workspace:*"`.
- **The offline commentator is a shipped feature, not a mock.** The design treats
  `mock-voice` as scaffolding; here the same idea is promoted to production so the
  game has a commentator with nothing configured. The real providers slot in behind
  the same interface.
- **Per-sport constants live on the sport module**, resolved into a per-match
  config, rather than being written into the global tuning object. Writing them
  globally is a cross-room data race the moment two sports are played at once.
- **The keyboard/mouse controller is a first-class input**, not just a test mock.
  It opens its own WebSocket as a controller and speaks the identical protocol, so
  it exercises the same code path a phone does.
- **`classifyEvents` handles state-derived events only** — streaks, comebacks,
  rally milestones, game point. Impulse events are emitted where they happen,
  because that is the only place their rich `data` payload exists.
- **WebRTC direct pose (path B) is not implemented.** The `PoseTransport` seam is
  where it would go; server-forwarded pose measures ~1 ms locally and is well
  inside budget over wifi.
