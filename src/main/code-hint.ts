/** Code mode on: one fixed line (the same every session, so cache-safe) on when run_code beats the shell. */
export const CODE_HINT = "To look around the project (list a folder, read several files, search), write one run_code script that chains read, glob and grep; read on a folder lists it. Keep the shell for git, builds, tests and edits.";

/** Codex 0.159+ always defers MCP tools behind its own tool search, so the hint says how to load run_code. */
export const CODE_HINT_DEFERRED = `${CODE_HINT} run_code is one of CubiQ's MCP tools behind your tool search: search for "run_code" once to load it, then use it.`;

/** OpenCode v2 reaches MCP tools only through its own Code Mode `execute`, so the line gives the exact call. */
export const OWN_CODE_MODE_HINT = "To look around the project (list a folder, read several files, search), call execute once with `return await tools.cubiq.run_code({ code: \"<script>\" })` (search the catalog for run_code if that path is missing): one script chains read, glob and grep, and read on a folder lists it. Do not read or search one file at a time. Keep the shell for git, builds, tests and edits.";
