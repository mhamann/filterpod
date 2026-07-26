/**
 * A skip control that shows how far it will skip.
 *
 * The increments are a setting, so a fixed "15"/"30" glyph is a promise the app cannot
 * keep — change the setting and the button lies about what it does. The number is drawn
 * from the same value the button acts on, inside the ring, where there is already a hole
 * in the icon shape.
 */

/**
 * Ring with an arrowhead at the top. Inner radius 6.4, which is the space for the number.
 *
 * Drawn thinner than the rest of the icon set on purpose. The general-purpose skip glyph
 * has a radius-5 hole, and two bold digits will not fit inside that at any size still
 * legible on a phone — they cross the ring. Widening the hole and lightening the stroke
 * makes room without shrinking the number into illegibility.
 */
const RING = {
  back: 'M12 4V1.2L6.6 5.2l5.4 4V5.6a6.4 6.4 0 1 1-6.4 6.4H4a8 8 0 1 0 8-8z',
  forward: 'M12 4V1.2l5.4 4-5.4 4V5.6a6.4 6.4 0 1 0 6.4 6.4h1.6a8 8 0 1 1-8-8z',
}

export function SkipIcon({
  seconds,
  direction,
  size = 28,
  className,
}: {
  seconds: number
  direction: 'back' | 'forward'
  size?: number
  className?: string
}) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={className}
      fill="currentColor"
      role="img"
      aria-label={`Skip ${direction === 'back' ? 'back' : 'forward'} ${seconds} seconds`}
    >
      <path d={RING[direction]} />
      <text
        x="12"
        // Not the geometric centre: text is positioned by its baseline, and the ring's
        // arrowhead occupies the top, so this sits the digits in the visual middle.
        y="14.6"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        // Tabular figures so 15 and 30 occupy the same width and the button does not
        // appear to shift when the setting changes.
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        {seconds}
      </text>
    </svg>
  )
}
