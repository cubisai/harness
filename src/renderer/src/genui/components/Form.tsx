import { useId, useState } from "react";
import { Select } from "../../components/Select";
import { sendUiReply } from "../reply";
import type { FormField, FormSpec } from "../types";

/** The one line a submitted form sends: `Form "<title>": id=value, …` (values quoted when they hold a comma). */
export function formReply(spec: FormSpec, values: Record<string, string>): string {
  const pairs = spec.fields.map((f) => {
    const v = (values[f.id] ?? "").trim();
    return `${f.id}=${/[,"]/.test(v) ? JSON.stringify(v) : v}`;
  });
  return `Form${spec.title ? ` "${spec.title}"` : ""}: ${pairs.join(", ")}`;
}

/** A field's starting value: a toggle starts at "no", a select at its first option. */
function initial(field: FormField): string {
  if (field.type === "toggle") return "no";
  if (field.type === "select") return field.options?.[0] ?? "";
  return "";
}

/** A small form; Submit sends one compact line as the user's message, then the form locks. */
export function Form({ spec }: { spec: FormSpec }) {
  const base = useId();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(spec.fields.map((f) => [f.id, initial(f)])));
  const [sent, setSent] = useState(false);
  const set = (id: string, value: string) => setValues((v) => ({ ...v, [id]: value }));
  return (
    <form
      className="ui-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (!sent && sendUiReply(formReply(spec, values))) setSent(true);
      }}
    >
      {spec.title ? <div className="ui-title">{spec.title}</div> : null}
      <fieldset disabled={sent}>
        {spec.fields.map((f) => {
          const id = `${base}-${f.id}`;
          return (
            <div key={f.id} className="ui-field">
              <label className="ui-field-label" htmlFor={id}>
                {f.label}
              </label>
              {f.type === "toggle" ? (
                <input id={id} type="checkbox" className="ui-toggle" checked={values[f.id] === "yes"} onChange={(e) => set(f.id, e.target.checked ? "yes" : "no")} />
              ) : f.type === "select" ? (
                <Select id={id} value={values[f.id] ?? ""} options={(f.options ?? []).map((o) => ({ value: o, label: o }))} onChange={(v) => set(f.id, v)} ariaLabel={f.label} disabled={sent} />
              ) : (
                <input id={id} type={f.type === "number" ? "number" : "text"} value={values[f.id]} onChange={(e) => set(f.id, e.target.value)} />
              )}
            </div>
          );
        })}
        <div className="ui-form-actions">
          <button type="submit" className="ui-submit">
            {sent ? "Sent" : "Send"}
          </button>
        </div>
      </fieldset>
    </form>
  );
}
