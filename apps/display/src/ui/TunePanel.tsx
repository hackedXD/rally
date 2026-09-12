/**
 * Live constant tuning (design §8.6).
 *
 * Every value in `tuning.ts` gets a slider, pushed to the server over the same
 * WebSocket. Two hours of work that pays for itself in the first tuning session,
 * because the alternative is editing a file and restarting a match to see whether
 * a shot feels better.
 */

import { useEffect, useState } from 'react';
import type { RallyClient } from '../net/client.js';
import { useGame } from '../store/useGame.js';

interface Props {
  client: RallyClient;
}

/** Sensible slider ranges. Anything unlisted gets a range around its default. */
const RANGES: Record<string, [number, number, number]> = {
  'shot.flightScale': [0.5, 1.6, 0.01],
  'shot.pressureSpread': [0, 6, 0.1],
  'shot.pressureNetBite': [0, 0.6, 0.01],
  'shot.pressureRush': [0, 0.6, 0.01],
  'shot.netClearance': [0, 0.6, 0.01],
  'shot.minLandingRatio': [0.2, 0.8, 0.01],
  'strike.hardWindowScale': [0.15, 1, 0.01],
  'strike.assistLow': [0, 1, 0.01],
  'strike.assistHigh': [0, 1, 0.01],
  'strike.timingWeight': [0, 1, 0.01],
  'strike.aimWeight': [0, 1, 0.01],
  'bot.skill': [0, 1, 0.01],
  'net.renderDelayMs': [0, 300, 5],
  'net.maxRewindMs': [0, 400, 10],
  'feel.shakeMaxPx': [0, 24, 1],
  'feel.telegraphLeadMs': [100, 1200, 10],
  'match.pointPauseMs': [500, 5000, 50],
};

export function TunePanel({ client }: Props) {
  const tuning = useGame((s) => s.tuning);
  const setTuning = useGame((s) => s.setTuning);
  const [local, setLocal] = useState<Record<string, number>>({});

  useEffect(() => {
    if (Object.keys(tuning).length) return;
    void fetch('/api/tuning')
      .then((r) => r.json())
      .then((j: { values: Record<string, number> }) => setTuning(j.values))
      .catch(() => undefined);
  }, [tuning, setTuning]);

  const values = { ...tuning, ...local };
  const groups = new Map<string, string[]>();
  for (const key of Object.keys(values).sort()) {
    const [group] = key.split('.');
    groups.set(group, [...(groups.get(group) ?? []), key]);
  }

  const push = (key: string, value: number) => {
    setLocal((l) => ({ ...l, [key]: value }));
    const [group, field] = key.split('.');
    client.tune({ [group]: { [field]: value } });
  };

  return (
    <div className="tune">
      <h3>Tuning · live</h3>
      {[...groups.entries()].map(([group, keys]) => (
        <div className="group" key={group}>
          <b>{group}</b>
          {keys.map((key) => {
            const value = values[key];
            const [min, max, step] = RANGES[key] ?? autoRange(value);
            return (
              <label key={key}>
                <span title={key}>{key.split('.')[1]}</span>
                <i>{format(value)}</i>
                <input
                  type="range"
                  min={min}
                  max={max}
                  step={step}
                  value={value}
                  style={{ gridColumn: '1 / -1' }}
                  onChange={(e) => push(key, Number(e.target.value))}
                />
              </label>
            );
          })}
        </div>
      ))}
      <div style={{ color: 'var(--dim)', fontSize: 11, marginTop: 8 }}>
        Changes apply to every live room immediately. Press <b>T</b> to close.
      </div>
    </div>
  );
}

function autoRange(value: number): [number, number, number] {
  if (value === 0) return [0, 1, 0.01];
  const mag = Math.abs(value);
  const step = mag > 100 ? 1 : mag > 10 ? 0.5 : mag > 1 ? 0.05 : 0.005;
  return [Math.min(0, value * 2), Math.max(mag * 2.5, mag + 1), step];
}

const format = (v: number): string =>
  Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3);
