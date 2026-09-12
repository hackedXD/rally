/**
 * The icon set.
 *
 * Drawn here rather than pulled from a font or pasted in as emoji: an emoji is
 * somebody else's typeface rendering at somebody else's weight, and on a court
 * made of 4px tape it reads as a sticker somebody left on the screen.
 *
 * One stroke weight (2.4 at a 24 unit box), square caps and joins, so they sit
 * on the same grid as the tape.
 */

interface Props {
  /** CSS length. Defaults to 1em so an icon matches the text it sits beside. */
  size?: number | string;
}

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2.4,
  strokeLinecap: 'square' as const,
  strokeLinejoin: 'miter' as const,
  'aria-hidden': true,
  focusable: false,
};

export function ChevronLeft({ size = '1em' }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M15 4 7 12l8 8" />
    </svg>
  );
}

export function ChevronRight({ size = '1em' }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M9 4l8 8-8 8" />
    </svg>
  );
}

/** Sound is off and the page has not been touched yet. */
export function Muted({ size = '1em' }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M17 9.5l4 5M21 9.5l-4 5" />
    </svg>
  );
}

export function Sound({ size = '1em' }: Props) {
  return (
    <svg {...base} width={size} height={size}>
      <path d="M4 9h4l5-4v14l-5-4H4z" />
      <path d="M17 8.5a5 5 0 0 1 0 7" />
    </svg>
  );
}
