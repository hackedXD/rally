/**
 * The end of a match, as the score sheet that comes off the court.
 *
 * The sheet takes the winner's side of the net for its colour, so who won is
 * legible from across the room before a single word has been read.
 */

import { lane, type Seat } from '@rally/protocol';
import { useGame } from '../store/useGame.js';

interface Props {
  onRematch: () => void;
  onLobby: () => void;
  ownSeat: Seat;
}

export function EndCard({ onRematch, onLobby, ownSeat }: Props) {
  const result = useGame((s) => s.result);
  const names = useGame((s) => s.names);
  if (!result) return null;

  const youWon = lane(result.winner) === lane(ownSeat);
  return (
    <div className="endcard">
      <div className={`sheet${youWon ? '' : ' lost'}`}>
        {/* One heading, carrying the whole result. A small "MATCH OVER" label
            above the name would say less than the name does and steal the top
            of the sheet to do it. */}
        <div className="who">
          {youWon ? 'You win' : `${names[lane(result.winner)]} wins`}
        </div>
        <div className="final">
          {result.final[0]} — {result.final[1]}
        </div>
        {result.summary.length > 0 && (
          <ul>
            {result.summary.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        )}
        <div className="end-actions">
          <button className="primary" onClick={onRematch}>
            Rematch
          </button>
          <button onClick={onLobby}>Back to the court</button>
        </div>
      </div>
    </div>
  );
}
