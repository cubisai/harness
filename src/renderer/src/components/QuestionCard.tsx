import { useEffect, useReducer, useRef, type KeyboardEvent } from "react";
import type { QuestionAnswer, QuestionRequest } from "../../../shared/types";
import { Markdown } from "../markdown";
import { answered, cardAnswer, initialCardState, questionCardReducer, type QuestionCardAction, type QuestionCardState } from "../question-card";

/**
 * The agent's questions, docked above the message box (Claude-app style): one
 * question at a time, options by click or number key, an "Other…" answer, and
 * Skip, which tells the agent to go on with its own defaults.
 */
export function QuestionCardView({ request, waiting, onRespond }: { request: QuestionRequest; waiting: number; onRespond: (a: QuestionAnswer) => void }) {
  const [state, dispatch] = useReducer((s: QuestionCardState, a: QuestionCardAction) => questionCardReducer(request.questions, s, a), initialCardState);
  const card = useRef<HTMLDivElement>(null);
  // The keys answer the card as soon as it shows; the composer keeps its draft.
  useEffect(() => card.current?.focus(), [request.requestId]);
  return <QuestionCardBody request={request} state={state} waiting={waiting} dispatch={dispatch} onRespond={onRespond} cardRef={card} />;
}

/** The card's markup and keys, hook-free so tests can drive it directly. */
export function QuestionCardBody({
  request,
  state,
  waiting,
  dispatch,
  onRespond,
  cardRef,
}: {
  request: QuestionRequest;
  state: QuestionCardState;
  waiting: number;
  dispatch: (a: QuestionCardAction) => void;
  onRespond: (a: QuestionAnswer) => void;
  cardRef?: React.Ref<HTMLDivElement>;
}) {
  const { questions } = request;
  const q = questions[state.step]!;
  const last = state.step === questions.length - 1;
  const picks = state.picks[q.id] ?? [];
  const freeText = q.options.length === 0;
  const otherOn = freeText || Boolean(state.otherOn[q.id]);
  const ready = answered(q, state);
  const submit = () => onRespond(cardAnswer(questions, state));
  const advance = () => (last ? submit() : dispatch({ type: "next" }));
  // A single choice moves straight on (unless a note is open); the last question waits for Submit.
  const choose = (label: string) => {
    dispatch({ type: "pick", label });
    // With the note field open, the user is still writing: stay on this question.
    if (!q.multiSelect && !last && !state.noteOn[q.id]) dispatch({ type: "next" });
  };
  const shown = q.options[state.cursor] ?? q.options.find((o) => picks.includes(o.label));
  const hasPreview = q.options.some((o) => o.preview);

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const typing = e.target instanceof HTMLInputElement;
    if (e.key === "Escape") {
      e.preventDefault();
      onRespond("dismiss");
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const row = q.options[state.cursor];
      if (!typing && row && !q.multiSelect && !picks.includes(row.label)) choose(row.label);
      else if (!typing && !row && q.allowOther && !otherOn) dispatch({ type: "other-on" });
      else if (ready) advance();
    } else if (typing) {
      return;
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      dispatch({ type: "cursor", delta: e.key === "ArrowDown" ? 1 : -1 });
    } else if (e.key === " " && q.multiSelect && q.options[state.cursor]) {
      e.preventDefault();
      dispatch({ type: "pick", label: q.options[state.cursor]!.label });
    } else if ((e.key === "n" || e.key === "N") && !freeText) {
      e.preventDefault();
      dispatch({ type: "note-on" });
    } else if (/^[1-9]$/.test(e.key)) {
      const i = Number(e.key) - 1;
      if (q.options[i]) {
        e.preventDefault();
        choose(q.options[i]!.label);
      } else if (i === q.options.length && q.allowOther) {
        e.preventDefault();
        dispatch({ type: "other-on" });
      }
    }
  };

  return (
    <div className="dock-card question-card" role="dialog" aria-label={q.question} tabIndex={-1} ref={cardRef} onKeyDown={onKeyDown}>
      <div className="dock-head">
        {q.header && <span className="dock-chip">{q.header}</span>}
        {questions.length > 1 && (
          <span className="dock-meta">
            {state.step + 1} of {questions.length}
          </span>
        )}
        {waiting > 0 && <span className="dock-meta">+{waiting} waiting</span>}
        {request.async && <span className="dock-meta" title="The agent keeps working; your answer goes back as a message">answer anytime</span>}
      </div>
      <div className="qc-question">{q.question}</div>
      <div className={`qc-body${hasPreview ? " with-preview" : ""}`}>
        <div className="qc-options" role="listbox" aria-multiselectable={q.multiSelect || undefined}>
          {q.options.map((o, i) => {
            const picked = picks.includes(o.label);
            return (
              <button
                key={o.label}
                type="button"
                role="option"
                aria-selected={picked}
                className={`qc-option${picked ? " picked" : ""}${state.cursor === i ? " cursor" : ""}`}
                onClick={() => (q.multiSelect ? dispatch({ type: "pick", label: o.label }) : choose(o.label))}
              >
                <span className="qc-key">{q.multiSelect ? (picked ? "✓" : "") : i + 1}</span>
                <span className="qc-text">
                  <span className="qc-label">{o.label}</span>
                  {o.description && <span className="qc-desc">{o.description}</span>}
                </span>
              </button>
            );
          })}
          {q.allowOther &&
            (otherOn ? (
              <div className={`qc-option other picked${state.cursor === q.options.length ? " cursor" : ""}`}>
                {!freeText && <span className="qc-key">{q.options.length + 1}</span>}
                <input
                  className="text-input qc-other"
                  type={q.secret ? "password" : "text"}
                  placeholder={freeText ? "Type your answer" : "Your own answer"}
                  value={state.other[q.id] ?? ""}
                  autoFocus
                  onChange={(e) => dispatch({ type: "other-text", text: e.target.value })}
                />
              </div>
            ) : (
              <button
                type="button"
                className={`qc-option other${state.cursor === q.options.length ? " cursor" : ""}`}
                onClick={() => dispatch({ type: "other-on" })}
              >
                <span className="qc-key">{q.options.length + 1}</span>
                <span className="qc-text">
                  <span className="qc-label">Other…</span>
                </span>
              </button>
            ))}
        </div>
        {!freeText &&
          (state.noteOn[q.id] ? (
            <input
              className="text-input qc-note"
              placeholder="Add a note for the agent (optional)"
              value={state.notes[q.id] ?? ""}
              autoFocus
              onChange={(e) => dispatch({ type: "note-text", text: e.target.value })}
            />
          ) : (
            <button type="button" className="qc-note-toggle" onClick={() => dispatch({ type: "note-on" })} title="Add context to your answer (N)">
              + Note
            </button>
          ))}
        {hasPreview && <div className="qc-preview">{shown?.preview ? <Markdown text={shown.preview} /> : <span className="qc-desc">No preview</span>}</div>}
      </div>
      <div className="actions">
        <button type="button" className="button" onClick={() => onRespond("dismiss")} title="The agent goes on with its own defaults (Esc)">
          Skip
        </button>
        <span className="dock-spacer" />
        {state.step > 0 && (
          <button type="button" className="button" onClick={() => dispatch({ type: "back" })}>
            Back
          </button>
        )}
        <button type="button" className="button primary" disabled={!ready} onClick={advance}>
          {last ? "Submit" : "Next"}
        </button>
      </div>
    </div>
  );
}
