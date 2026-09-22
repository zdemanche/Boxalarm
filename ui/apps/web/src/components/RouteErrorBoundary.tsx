import { Component, type ReactNode } from 'react';
import { ApiErrorState } from './ApiErrorState';

interface RouteErrorBoundaryState {
  failed: boolean;
}

/**
 * Route-level error boundary, distinct from App.tsx's ConfigErrorBoundary. ConfigErrorBoundary
 * wraps the whole app and owns the unrecoverable "Boxalarm can't start / sign-in configuration
 * is missing or invalid" message reserved for a genuinely missing/invalid auth config; before
 * this boundary existed, ANY render-time error in a routed page (a component throwing on a
 * transient backend 500, an offline fetch rejection, etc.) fell through to that same message,
 * even though those are retryable and unrelated to sign-in config. AppShell keys this
 * boundary by the current route so navigating away also recovers it.
 */
export class RouteErrorBoundary extends Component<
  { children: ReactNode },
  RouteErrorBoundaryState
> {
  state: RouteErrorBoundaryState = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  private handleRetry = () => {
    this.setState({ failed: false });
  };

  render() {
    if (this.state.failed) {
      return <ApiErrorState onRetry={this.handleRetry} />;
    }
    return this.props.children;
  }
}
