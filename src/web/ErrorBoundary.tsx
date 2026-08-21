import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryState {
  failed: boolean;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[agent-flight-recorder] Console render failed', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <main className="fatal-state" role="alert">
        <p>LOCAL CONSOLE INTERRUPTED</p>
        <h1>The recorder data is safe.</h1>
        <span>The replay console hit an unexpected rendering error. Reload to reconnect to the loopback service.</span>
        <button type="button" onClick={() => window.location.reload()}>
          RELOAD CONSOLE
        </button>
      </main>
    );
  }
}
