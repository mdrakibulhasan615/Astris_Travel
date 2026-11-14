import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional compact fallback (e.g. for the map panel); defaults to a full-page recovery screen. */
  fallback?: ReactNode;
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * Catches render-time errors (e.g. maplibre failing without WebGL, malformed leg data)
 * so a single broken widget doesn't blank the whole planner.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ErrorBoundary${this.props.label ? `:${this.props.label}` : ''}]`, error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;

    return (
      <div role="alert" className="min-h-screen flex items-center justify-center bg-neutral-50 p-6">
        <div className="max-w-md w-full rounded-2xl border border-neutral-200 bg-white p-6 shadow-sm">
          <h1 className="text-lg font-semibold text-neutral-900">Something went wrong</h1>
          <p className="mt-2 text-sm text-neutral-600">
            The trip planner hit an unexpected error. Your itinerary is safe on the server; try again.
          </p>
          <pre className="mt-3 max-h-32 overflow-auto rounded-lg bg-neutral-100 p-2 text-xs text-neutral-700">
            {this.state.error.message}
          </pre>
          <div className="mt-4 flex gap-2">
            <button
              type="button"
              onClick={this.reset}
              className="rounded-lg bg-[#FF812E] px-4 py-2 text-sm font-medium text-white"
            >
              Try again
            </button>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="rounded-lg border border-neutral-300 px-4 py-2 text-sm font-medium text-neutral-700"
            >
              Reload
            </button>
          </div>
        </div>
      </div>
    );
  }
}
