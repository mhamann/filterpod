/**
 * Simplified marks of the apps FilterPod can import from.
 *
 * Hand-drawn approximations rather than bundled brand assets, used nominatively — the
 * "sign in with" convention — to say "your subscriptions can come from here". Each is a
 * brand-colour disc with the recognisable gesture of the logo, which at 28px is what
 * actually reads; pixel-faithful trademarks at this size would not.
 */

function Disc({ fill, children }: { fill: string; children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" width="100%" height="100%">
      <circle cx="12" cy="12" r="12" fill={fill} />
      {children}
    </svg>
  )
}

export function SpotifyLogo() {
  return (
    <Disc fill="#1DB954">
      {[
        ['M6.5 9.6 Q12 7.8 17.5 10.1', 1.9],
        ['M7.2 12.6 Q12 11.1 16.6 13.0', 1.6],
        ['M7.9 15.4 Q12 14.2 15.8 15.8', 1.3],
      ].map(([d, w]) => (
        <path
          key={d as string}
          d={d as string}
          fill="none"
          stroke="#0d0908"
          strokeWidth={w as number}
          strokeLinecap="round"
        />
      ))}
    </Disc>
  )
}

export function PocketCastsLogo() {
  return (
    <Disc fill="#F43E37">
      <path
        d="M12 5.2 A6.8 6.8 0 1 0 18.8 12"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
      <path
        d="M12 8.4 A3.6 3.6 0 1 0 15.6 12"
        fill="none"
        stroke="#fff"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </Disc>
  )
}

export function OvercastLogo() {
  return (
    <Disc fill="#FC7E0F">
      <circle cx="12" cy="12" r="2" fill="#fff" />
      {[
        ['M8.2 8.6 A5.4 5.4 0 0 0 8.2 15.4', 'M15.8 8.6 A5.4 5.4 0 0 1 15.8 15.4'],
      ][0].map((d) => (
        <path key={d} d={d} fill="none" stroke="#fff" strokeWidth="1.7" strokeLinecap="round" />
      ))}
    </Disc>
  )
}

export function ApplePodcastsLogo() {
  return (
    <Disc fill="#B150E2">
      <circle cx="12" cy="10" r="2.1" fill="#fff" />
      <path d="M10.4 17.5 q1.6 -4 3.2 0 q-1.6 2.4 -3.2 0z" fill="#fff" />
      <path
        d="M7.6 8.5 a6 6 0 0 1 8.8 0"
        fill="none"
        stroke="#fff"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </Disc>
  )
}

/** The overlapping cluster used wherever import is offered. */
export function ImportLogoCluster({ size = 30 }: { size?: number }) {
  const logos = [PocketCastsLogo, SpotifyLogo, OvercastLogo, ApplePodcastsLogo]
  return (
    <span className="flex items-center">
      {logos.map((Logo, index) => (
        <span
          key={index}
          className="rounded-full ring-2 ring-panel-950"
          style={{ width: size, height: size, marginLeft: index === 0 ? 0 : -size * 0.28 }}
        >
          <Logo />
        </span>
      ))}
    </span>
  )
}
