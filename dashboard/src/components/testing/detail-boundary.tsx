/**
 * Old runs are read back from disk months after the shape of a result changed, and a
 * row the renderer cannot make sense of should cost that row, not the whole page.
 */
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
}

export class DetailBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  render(): ReactNode {
    if (this.state.failed) {
      return (
        <p className="border-t border-border/60 bg-muted/20 px-3 py-3 text-sm text-muted-foreground">
          This result was recorded by an older version of the lab and cannot be shown here. Its raw JSON is under{' '}
          <code className="font-mono text-xs">calls/testlab/runs</code>.
        </p>
      );
    }
    return this.props.children;
  }
}
