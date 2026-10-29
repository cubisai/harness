# Judge calibrations

One `<name>.json` per judge rubric, referenced by a task's `{ "type": "judge", "rubric": "...", "calibration": "<name>" }` grader:

```json
{ "rubric": "…the same text as the grader's rubric…", "examples": [{ "transcript": "assistant: …", "label": true }] }
```

`bun run eval --calibrate-judge <name>` judges every labelled example and stores `report` (accuracy, Cohen's kappa, n, model, date). A judge grader counts only when the report shows accuracy ≥ 0.85 on ≥ 10 examples and the rubric still matches; otherwise its trial is "ungraded", never failed.
