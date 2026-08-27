import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props { children: ReactNode }
interface State { error: Error | null }

/** A render crash should say so, not leave a blank page.
 *
 * This matters more than usual here: an agent can drive the interface into
 * states a person would not reach by hand, and a white screen gives neither the
 * clinician nor the agent anything to act on. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("CoAuth interface error", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div className="crash" role="alert" data-testid="error-boundary">
        <h1>The interface stopped responding</h1>
        <p>
          Something in the page failed to render. Nothing has been submitted: a prior authorization is only
          submitted once a clinician has signed it and the server has verified that signature.
        </p>
        <pre className="crash-detail">{error.message}</pre>
        <button className="btn btn-primary" style={{ width: "auto" }} onClick={() => window.location.reload()}>
          Reload the page
        </button>
      </div>
    );
  }
}
