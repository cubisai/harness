import { type ReactNode, useMemo } from "react";
import { validateUi } from "./validate";
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
 * doesn't validate, the caller's `fallback` (the fence as plain code) shows.
 */
export function UiBlock({ name, body, fallback }: { name: string; body: string; fallback: ReactNode }) {
  const spec = useMemo(() => validateUi(name, body), [name, body]);
  if (!spec) return <>{fallback}</>;
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
    <div className="ui-block" data-ui={spec.name}>
      {view}
    </div>
  );
}
