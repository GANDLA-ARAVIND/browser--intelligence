import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * A render error in an extension page is worse than in a normal web app: the
 * tab goes blank, and the stack lands only in a devtools console the user is
 * unlikely to have open. This turns that into something visible and legible.
 *
 * It is a backstop, not error handling — an unreachable service worker is an
 * ordinary state and belongs in the UI as a red row, not here.
 */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[dashboard] render error', error, info.componentStack);
  }

  override render(): ReactNode {
    const { error } = this.state;
    if (error === null) return this.props.children;

    return (
      <main>
        <h1>Something broke</h1>
        <p className="tagline">The dashboard hit a render error and stopped.</p>
        <section className="panel">
          <h2>Error</h2>
          <pre className="stack">{error.message}</pre>
          {error.stack !== undefined && <pre className="stack muted-stack">{error.stack}</pre>}
          <div className="actions">
            <button type="button" onClick={() => this.setState({ error: null })}>
              Try again
            </button>
            <button type="button" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </section>
        <p className="note">
          If this followed a rebuild, reload the extension at
          chrome://extensions — a page talking to a service worker from the
          previous build is the usual cause.
        </p>
      </main>
    );
  }
}
