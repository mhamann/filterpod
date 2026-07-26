import { Component, type ErrorInfo, type ReactNode } from 'react'
import { Button } from '@/ui/components'
import { Icon } from '@/ui/Icon'

/**
 * Catches render errors so one bad screen degrades to a recoverable message rather
 * than unmounting the whole app and leaving a black rectangle.
 */
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('FilterPod render error', error, info.componentStack)
  }

  render() {
    const { error } = this.state
    if (!error) return this.props.children

    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-alarm-500/12 text-alarm-400 ring-1 ring-alarm-500/25">
          <Icon name="warning" size={24} />
        </div>
        <h2 className="text-lg">Something broke on this screen</h2>
        <p className="max-w-xs font-mono text-[12px] leading-relaxed break-words text-ink-600">
          {error.message}
        </p>
        <Button variant="secondary" onClick={() => this.setState({ error: null })}>
          Try again
        </Button>
      </div>
    )
  }
}
