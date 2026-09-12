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
      <div className="inner">
        <div className="win">{youWon ? 'You win' : 'Match over'}</div>
        <div className="who">{names[lane(result.winner)]}</div>
        <div className="final">
          {result.final[0]} — {result.final[1]}
        </div>
        <ul>
          {result.summary.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
        <div style={{ display: 'flex', gap: 10, justifyContent: 'center' }}>
          <button className="primary" onClick={onRematch}>
            Rematch
          </button>
          <button onClick={onLobby}>Back to lobby</button>
        </div>
      </div>
    </div>
  );
}
