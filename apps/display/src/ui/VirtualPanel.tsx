import type { CSSProperties } from 'react';
import type { VirtualState } from '../net/virtual.js';

interface Props {
  state: VirtualState;
  onServe: () => void;
}

/** The on-screen readout for the mouse controller. */
export function VirtualPanel({ state, onServe }: Props) {
  return (
    <div className="vc">
      <div className="t">Mouse controller</div>
      <div>Move to aim · hold to wind up · release to swing</div>
      <div className="meter">
        <i style={{ '--p': state.charge } as CSSProperties} />
      </div>
      <div className="row">
        <span>{state.swings} swings</span>
        <span>{state.lastSwingSpeed.toFixed(1)} m/s</span>
      </div>
      {state.yourServe && (
        <button
          className="primary"
          style={{ width: '100%', marginTop: 10 }}
          onClick={onServe}
        >
          Serve
        </button>
      )}
    </div>
  );
}
