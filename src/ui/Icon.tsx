/**
 * Inline icon set.
 *
 * Bundled as paths rather than pulled from an icon library: the app must work fully
 * offline, and this is a couple of kilobytes against a dependency.
 */

const PATHS = {
  play: 'M8 5.5v13l11-6.5z',
  pause: 'M9 5h2.5v14H9zM14.5 5H17v14h-2.5z',
  back15: 'M12 5V2L7 6l5 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  forward30: 'M12 5V2l5 4-5 4V7a5 5 0 1 0 5 5h2a7 7 0 1 1-7-7z',
  library: 'M4 5h2v14H4zM8 5h2v14H8zM13 5.5l2-.5 4 13.5-2 .6z',
  search: 'M11 4a7 7 0 1 1-4.2 12.6l-3.1 3.1-1.4-1.4 3.1-3.1A7 7 0 0 1 11 4zm0 2a5 5 0 1 0 0 10 5 5 0 0 0 0-10z',
  download: 'M12 3v9.2l3.1-3.1 1.4 1.4-5.5 5.5-5.5-5.5 1.4-1.4L10 12.2V3zM4 18h16v2H4z',
  settings:
    'M12 8a4 4 0 1 1 0 8 4 4 0 0 1 0-8zm0 2a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7.4 2 1.8 1.4-1.7 3-2.2-.7a7.6 7.6 0 0 1-1.4.8l-.5 2.2h-3.4l-.5-2.2a7.6 7.6 0 0 1-1.4-.8l-2.2.7-1.7-3L7.6 12a7.7 7.7 0 0 1 0-1.6L5.8 9l1.7-3 2.2.7c.44-.32.9-.6 1.4-.8L11.6 4h3.4l.5 2.2c.5.2.96.47 1.4.8l2.2-.7 1.7 3-1.8 1.4c.05.53.05 1.07 0 1.6z',
  check: 'M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6L20.4 8.2 19 6.8z',
  close: 'M18.3 5.7 12 12l6.3 6.3-1.4 1.4L10.6 13.4 4.3 19.7l-1.4-1.4L9.2 12 2.9 5.7l1.4-1.4 6.3 6.3 6.3-6.3z',
  chevronDown: 'M12 15.4 5.6 9l1.4-1.4 5 5 5-5L18.4 9z',
  chevronRight: 'M9 18.4 7.6 17l5-5-5-5L9 5.6l6.4 6.4z',
  scissors:
    'M9.6 3.4 14 10.9l1.6-2.7 3.9 6.7-1.7 1-2.9-5-.9 1.6 1.5 2.6a3 3 0 1 1-1.7 1l-1.3-2.3-1.3 2.3a3 3 0 1 1-1.7-1l1.5-2.6L4.5 3.4zM7.5 17a1 1 0 1 0 0 2 1 1 0 0 0 0-2zm9 0a1 1 0 1 0 0 2 1 1 0 0 0 0-2z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  trash: 'M9 3h6l1 2h4v2H4V5h4zM6 8h12l-1 13H7z',
  refresh:
    'M12 5V2L8 6l4 4V7a5 5 0 1 1-5 5H5a7 7 0 1 0 7-7z',
  shield:
    'M12 2 4 5.5v6c0 4.6 3.4 8.9 8 10.5 4.6-1.6 8-5.9 8-10.5v-6zm0 2.2 6 2.6v4.7c0 3.5-2.5 6.9-6 8.3-3.5-1.4-6-4.8-6-8.3V6.8z',
  warning: 'M12 3 1.5 21h21zm0 4.5 6.6 11.5H5.4zM11 11h2v4h-2zm0 5h2v2h-2z',
} as const

export type IconName = keyof typeof PATHS

interface IconProps {
  name: IconName
  size?: number
  className?: string
}

export function Icon({ name, size = 20, className }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}
