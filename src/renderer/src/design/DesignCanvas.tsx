/**
 * A design thread's canvas column, loaded only when a design thread opens so
 * the Chat bundle stays as it was. D1 is the empty shell; the live frame,
 * toolbar and reload come with D2.
 */
export default function DesignCanvas(_props: { threadId: string }) {
  return (
    <section className="design-canvas" aria-label="Design canvas">
      <header className="design-canvas-head drag">
        <span className="design-canvas-title">Canvas</span>
      </header>
      <div className="design-canvas-empty">
        <div>
          <h2>Nothing to show yet</h2>
          <p>Your design appears here once the agent writes it.</p>
        </div>
      </div>
    </section>
  );
}
