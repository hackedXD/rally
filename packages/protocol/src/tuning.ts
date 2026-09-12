/**
 * THE ONLY PLACE A GAMEPLAY NUMBER IS ALLOWED TO LIVE.
 *
 * Coding standard 3: if it is a number that might change, it goes here. The
 * live tuning panel (`tools/tune`) patches this object over the WebSocket at
 * runtime, which is why `TUNING` is mutable and `DEFAULT_TUNING` is frozen.
 *
 * Every value is a starting point derived from the design, not a measured
 * optimum. Expect to move half of them.
 */

export interface Tuning {
  net: {
    tickHz: number;
    snapshotHz: number;
    poseHz: number;
    renderDelayMs: number;
    maxRewindMs: number;
    pingIntervalMs: number;
    clockWindow: number;
    disconnectGraceMs: number;
    /** How many ticks of ball history the server keeps for rewind + replay. */
    historyTicks: number;
    /** Ball extrapolation ceiling on the display when the snapshot buffer runs dry. */
    extrapolateMaxMs: number;
  };
  /**
   * Paddle stroke prediction — latency compensation on the pose the phone
   * sends. See `@rally/motion/predict`.
   */
  predict: {
    /**
     * Fraction of the measured lead actually applied. 0 turns prediction off,
     * which is the point of it being a slider rather than a constant: the
     * feature can be A/B'd mid-rally against the exact code path that ships.
     */
    leadScale: number;
    /**
     * How far ahead the model is ever willing to guess, ms.
     *
     * Past this the guess is worth less than the lag it hides, and a single
     * dropped packet on a bad network would otherwise fling the paddle a
     * quarter turn. The cap is the guarantee, not the estimate.
     */
    maxLeadMs: number;
    /**
     * Sensor sample -> event handler, ms. Not measurable from JavaScript; the
     * iOS pipeline is about a frame, and `maxLeadMs` bounds what being wrong
     * about it can cost.
     */
    sensorLagMs: number;
    /**
     * Rotation rates below this are noise rather than a stroke, deg/s.
     *
     * A hand held still still reports a degree or two a second of gyro noise.
     * Leading on that adds jitter to the one thing on screen that was steady.
     */
    minRateDps: number;
  };
  motion: {
    fuseAlpha: number;
    swingOnsetAccel: number;
    swingEndAccel: number;
    swingEndHoldMs: number;
    swingMaxMs: number;
    refractoryMs: number;
    /** Verified empirically on device in Stage 0; see §8.1.1. */
    accelSign: number;
    /** Gyro samples below this magnitude (rad/s) are treated as noise. */
    gyroDeadzone: number;
    /** Peak hand speed that maps to a maximum-power shot, m/s. */
    speedCeiling: number;
    /** Below this peak speed a burst is a twitch, not a swing. */
    minSwingSpeed: number;
    /** Calibration sample window. */
    calibrationMs: number;
  };
  strike: {
    /**
     * NOTE: windowMs, aimToleranceDeg, contactHeight, reachDepth and the pace
     * range are per-SPORT and live on `SportModule.strike`; they are resolved
     * into `SimParams` per match. Only genuinely global knobs belong here.
     */
    timingWeight: number;
    aimWeight: number;
    assistLow: number;
    assistHigh: number;
    reconcileMs: number;
    reconcileBlendBackMs: number;
    /** Quality at or below this is "mostly assisted". */
    lowQualityCut: number;
    /** Quality at or above this is "mostly the player". */
    highQualityCut: number;
    /** Lateral reach from the auto-positioned body, metres. */
    reachWidth: number;
    /** Strike window multiplier at difficulty 1. The rally-decay knob. */
    hardWindowScale: number;
    /** Maximum achievable quality multiplier at difficulty 1. */
    hardQualityScale: number;
    /** Weights that make up difficulty: pace, ground covered, awkward height. */
    diffPaceWeight: number;
    diffTravelWeight: number;
    diffHeightWeight: number;
    /** Difficulty floor for a recovery swing after a whiff. */
    scrambleDifficulty: number;
    /**
     * For a ball that never bounces: how many metres of running a metre of
     * awkward contact height is worth, when choosing where to meet it.
     *
     * 0 means the receiver stands still and takes the shuttle at whatever height
     * it happens to reach them — a lot of scraping it off the floor, and a lot of
     * net errors. Large means they always move to meet it at a perfect height,
     * which collapses every rally onto the net. Only sports whose ball does not
     * bounce consult it; the others have a bounce to wait for instead.
     */
    contactComfortBias: number;
    /**
     * What a metre of reach ABOVE the comfortable contact height costs, relative
     * to a metre below it.
     *
     * Height is not symmetrical and treating it as though it were is what makes
     * overheads feel dead. A ball above your shoulder is the one you want — you
     * step under it and hit down. A ball at your ankles is the one that beats
     * you. Below 1, the model agrees: contacts above comfortable are cheaper to
     * move to and carry less difficulty, so a badminton overhead is the easy
     * attacking shot it should be rather than the hardest thing on the court.
     */
    highReachEase: number;
  };
  shot: {
    driveMinSpeed: number;
    driveMaxElevDeg: number;
    dinkMaxSpeed: number;
    lobMinElevDeg: number;
    smashMinSpeed: number;
    smashMaxElevDeg: number;
    minReturn: number;
    maxReturn: number;
    /**
     * Global multiplier on every shot's flight time. The single most useful
     * number in the file: raise it and rallies become readable, lower it and the
     * game gets frantic.
     */
    flightScale: number;
    /** Fraction of the opponent's half a safe assisted shot aims for. */
    safeDepth: number;
    /** Random lateral spread on assisted shots, metres. */
    safeSpread: number;
    /** Minimum clearance over the net an assisted shot is granted, metres. */
    netClearance: number;
    /**
     * Shortest landing distance past the net, as a fraction of how far behind
     * the net contact was made. Below about 0.35 the required trajectory stops
     * existing once drag is applied. Raise it if soft shots keep finding the net.
     */
    minLandingRatio: number;
    /** Metres of placement scatter at full pressure. The rally-decay knob. */
    pressureSpread: number;
    /**
     * Metres of net clearance that full pressure eats. Large enough to go
     * negative makes net errors a pressure mechanic rather than an accident.
     */
    pressureNetBite: number;
    /** Landing error, metres, still counted as an accurate shot. */
    placementTolerance: number;
    /** How much pressure shortens flight time — a rushed shot is flatter. */
    pressureRush: number;
    /** Latitude below which a shot no longer gets rescued into play. */
    rescueLatitudeCut: number;
  };
  serve: {
    /** Power multiplier applied to serves — a flick should still make it over. */
    powerScale: number;
    /** Serves land this fraction of the way into the opponent's half. */
    targetDepth: number;
    /** How strongly serves are assisted toward a legal box. 1 = always legal. */
    assist: number;
    /** Seconds the server has to swing before the sim serves for them. */
    autoServeAfterMs: number;
    /** Ball is held this high before the serve toss, metres. */
    holdHeight: number;
    /**
     * Beat between the last player readying up and the serve, ms.
     *
     * Without it the serve lands on the same frame as the tap, which reads as
     * the game jumping the gun — you are still lowering the phone from the
     * button when the ball is already past you.
     *
     * This is the pause a server takes to bounce the ball and look up, so it is
     * short: two seconds was a machine waiting out a timer, and it felt like
     * one. Jittered for the same reason — a beat identical to the millisecond,
     * twenty times a match, is the tell that nobody is on the other end.
     */
    readyDelayMs: number;
    /** Random extra on top of `readyDelayMs`, ms. Nobody is metronomic. */
    readyDelayJitterMs: number;
  };
  bot: {
    /** 0 = helpless, 1 = frame-perfect. */
    skill: number;
    /** Mean reaction offset applied to the bot's swing timing, ms. */
    timingBiasMs: number;
    /** Random timing jitter, ms, scaled down by skill. */
    timingJitterMs: number;
    /** Chance per shot the bot simply misses, at skill 0. */
    whiffChance: number;
    /** Chance the bot goes for a winner when the ball sits up. */
    aggression: number;
  };
  commentary: {
    minSalience: number;
    coldBankSize: number;
    speculativeInFlight: number;
    speculativeTimeoutMs: number;
    speculativeEveryNHits: number;
    queueMaxDepth: number;
    queueStaleMs: number;
    duckMusicDb: number;
    duckSfxDb: number;
    duckRampMs: number;
    maxCharsPerMatch: number;
    /** Minimum gap between two spoken lines, ms. Silence is a valid output. */
    minGapMs: number;
    /** Live-layer generation budget before we give up and stay quiet, ms. */
    liveTimeoutMs: number;
    /** Verbatim lines remembered for de-duplication. */
    recentQuipMemory: number;
    /** Rolling concrete facts handed to the writer. */
    factMemory: number;
    /**
     * Breath left after a line before play is allowed to resume, ms.
     *
     * A serve that lands on the commentator's last syllable reads as an
     * interruption even though nothing was actually cut.
     */
    holdTailMs: number;
    /**
     * Longest the match will wait for the commentator, ms.
     *
     * The safety valve on the whole mechanism. Commentary holds the next serve
     * so a line is never talked over, and without a ceiling a provider that
     * hands back a forty-second monologue — or an estimate that is simply wrong
     * — stops the game instead of narrating it.
     */
    holdPlayMaxMs: number;
  };
  feel: {
    /** Ball trail length, in samples. */
    trailLength: number;
    hitstopMs: number;
    shakeMaxPx: number;
    shakeDecayMs: number;
    flashMs: number;
    /** Telegraph ring starts closing this long before ideal contact, ms. */
    telegraphLeadMs: number;
    replaySlowMo: number;
    replayLengthMs: number;
  };
  match: {
    pointsToWin: number;
    winBy: number;
    /** Dead time after a point before the next serve, ms. */
    pointPauseMs: number;
    /** Dead time after match end before the lobby returns, ms. */
    gameOverPauseMs: number;
  };
}

export const DEFAULT_TUNING: Tuning = {
  net: {
    tickHz: 60,
    snapshotHz: 30,
    poseHz: 30,
    renderDelayMs: 100,
    maxRewindMs: 200,
    pingIntervalMs: 2000,
    clockWindow: 8,
    disconnectGraceMs: 10_000,
    historyTicks: 200,
    extrapolateMaxMs: 120,
  },
  predict: {
    leadScale: 1,
    maxLeadMs: 90,
    sensorLagMs: 16,
    minRateDps: 8,
  },
  motion: {
    fuseAlpha: 0.02,
    swingOnsetAccel: 12.0,
    swingEndAccel: 4.0,
    swingEndHoldMs: 40,
    swingMaxMs: 500,
    refractoryMs: 250,
    accelSign: 1,
    gyroDeadzone: 0.02,
    speedCeiling: 9.0,
    minSwingSpeed: 1.1,
    calibrationMs: 1500,
  },
  strike: {
    timingWeight: 0.65,
    aimWeight: 0.35,
    assistLow: 0.15,
    assistHigh: 0.9,
    reconcileMs: 90,
    reconcileBlendBackMs: 120,
    lowQualityCut: 0.4,
    highQualityCut: 0.85,
    reachWidth: 1.5,
    hardWindowScale: 0.42,
    hardQualityScale: 0.72,
    diffPaceWeight: 0.55,
    diffTravelWeight: 0.32,
    diffHeightWeight: 0.13,
    scrambleDifficulty: 0.6,
    contactComfortBias: 2.2,
    highReachEase: 0.25,
  },
  shot: {
    driveMinSpeed: 6.0,
    driveMaxElevDeg: 10,
    dinkMaxSpeed: 3.0,
    lobMinElevDeg: 25,
    smashMinSpeed: 7.0,
    smashMaxElevDeg: -15,
    minReturn: 6.0,
    maxReturn: 18.0,
    flightScale: 0.85,
    safeDepth: 0.66,
    safeSpread: 1.1,
    netClearance: 0.2,
    minLandingRatio: 0.42,
    pressureSpread: 3.2,
    pressureNetBite: 0.22,
    placementTolerance: 0.5,
    pressureRush: 0.3,
    rescueLatitudeCut: 0.45,
  },
  serve: {
    powerScale: 1.15,
    targetDepth: 0.62,
    assist: 0.85,
    autoServeAfterMs: 12_000,
    holdHeight: 0.95,
    readyDelayMs: 850,
    readyDelayJitterMs: 500,
  },
  bot: {
    skill: 0.55,
    timingBiasMs: 0,
    timingJitterMs: 115,
    whiffChance: 0.3,
    aggression: 0.45,
  },
  commentary: {
    minSalience: 0.25,
    coldBankSize: 40,
    speculativeInFlight: 3,
    speculativeTimeoutMs: 900,
    speculativeEveryNHits: 4,
    queueMaxDepth: 4,
    queueStaleMs: 9000,
    duckMusicDb: -10,
    duckSfxDb: -6,
    duckRampMs: 80,
    maxCharsPerMatch: 12_000,
    minGapMs: 700,
    liveTimeoutMs: 4000,
    recentQuipMemory: 8,
    factMemory: 12,
    holdTailMs: 350,
    holdPlayMaxMs: 7000,
  },
  feel: {
    trailLength: 12,
    hitstopMs: 25,
    shakeMaxPx: 8,
    shakeDecayMs: 200,
    flashMs: 40,
    telegraphLeadMs: 400,
    replaySlowMo: 0.35,
    replayLengthMs: 3000,
  },
  match: {
    pointsToWin: 7,
    winBy: 2,
    pointPauseMs: 1900,
    gameOverPauseMs: 9000,
  },
};

/** Live, patchable copy. Read this at use sites; never copy values out early. */
export const TUNING: Tuning = structuredCloneish(DEFAULT_TUNING);

export type TuningPatch = {
  [K in keyof Tuning]?: Partial<Tuning[K]>;
};

/** Apply a shallow-per-group patch. Unknown keys are ignored, not thrown. */
export function applyTuningPatch(patch: TuningPatch): void {
  for (const group of Object.keys(patch) as (keyof Tuning)[]) {
    const incoming = patch[group];
    const target = TUNING[group] as Record<string, number>;
    if (!incoming || !target) continue;
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value === 'number' && Number.isFinite(value) && key in target) {
        target[key] = value;
      }
    }
  }
}

export function resetTuning(): void {
  applyTuningPatch(DEFAULT_TUNING as TuningPatch);
}

/** Flatten to `group.key` → value, for the tuning panel's slider list. */
export function flattenTuning(t: Tuning = TUNING): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [group, values] of Object.entries(t)) {
    for (const [key, value] of Object.entries(values as Record<string, number>)) {
      out[`${group}.${key}`] = value;
    }
  }
  return out;
}

function structuredCloneish<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
