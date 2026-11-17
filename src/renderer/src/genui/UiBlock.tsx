import { type ReactNode, useMemo } from "react";
import { validateUiDetailed } from "./validate";
import { Calculator } from "./components/Calculator";
import { Cards } from "./components/Cards";
import { Chart } from "./components/Chart";
import { Checklist } from "./components/Checklist";
import { Choices } from "./components/Choices";
import { Compare } from "./components/Compare";
import { Form } from "./components/Form";
import { Stat } from "./components/Stat";
import { Timeline } from "./components/Timeline";

/**
 * Draws one inline UI block from a validated ```ui:<name> fence. When the body
 * doesn't validate, the caller's `fallback` (the fence as plain code) shows,
 * under one muted line saying why. Repairs to a drawn block (clipped texts,
 * padded rows) go in `data-ui-notes` only: a drawn block still says what the agent meant, so it doesn't nag.
 */
export function UiBlock({ name, body, fallback }: { name: string; body: string; fallback: ReactNode }) {
  const verdict = useMemo(() => validateUiDetailed(name, body), [name, body]);
  if (!verdict.spec) {
    return (
      <>
        <div className="ui-fallback-note">
          Couldn't draw ui:{name}: {verdict.reason}
        </div>
        {fallback}
      </>
    );
  }
  const { spec, notes } = verdict;
  let view: ReactNode = null;
  switch (spec.name) {
    case "checklist":
      view = <Checklist spec={spec} />;
      break;
    case "calculator":
      view = <Calculator spec={spec} />;
      break;
    case "compare":
      view = <Compare spec={spec} />;
      break;
    case "timeline":
      view = <Timeline spec={spec} />;
      break;
    case "chart":
      view = <Chart spec={spec} />;
      break;
    case "choices":
      view = <Choices spec={spec} />;
      break;
    case "form":
      view = <Form spec={spec} />;
      break;
    case "stat":
      view = <Stat spec={spec} />;
      break;
    case "cards":
      view = <Cards spec={spec} />;
      break;
  }
  return (
    <div className="ui-block" data-ui={spec.name} data-ui-notes={notes.length ? notes.join("; ") : undefined}>
      {view}
    </div>
  );
}
