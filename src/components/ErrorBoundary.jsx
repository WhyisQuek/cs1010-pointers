/** Keeps one failing page from blanking the whole app. */
import { Component } from 'react';

export default class ErrorBoundary extends Component {
  state = { error: null };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidUpdate(previous) {
    // Switching pages gives the new page a fresh chance to render.
    if (this.state.error && previous.resetKey !== this.props.resetKey)
      this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page" role="alert">
        <h2>Something went wrong</h2>
        <p className="msgbar-inline err">{this.state.error.message}</p>
        <button className="plain-btn" onClick={() => this.setState({ error: null })}>
          Try again
        </button>
      </div>
    );
  }
}
