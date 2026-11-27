// What an automation reads from (sources) and delivers to (destinations).

/** One read past a bookmark: the new items and the bookmark to confirm once they're delivered. */
export interface SourceRead {
  items: string[];
  /** null = nothing new; the cursor stays where it is. */
  next: string | null;
}

/** A readable input. read() throws when the source is unreachable, never returns "no new items" for that. */
export interface Source {
  id: string;
  read(bookmark: string | null, ctx: { projectId: string; cwd: string }): Promise<SourceRead>;
}

export interface DeliveryPayload {
  /** The idempotency key: the same key is delivered at most once. */
  key: string;
  automationId: string;
  runId: number;
  threadId: string;
  title: string;
  text: string;
}

/** Destinations that can look up their opaque receipt return it with the confirmation. */
export type DeliveryCheck = "confirmed" | { state: "confirmed"; receipt: string } | "missing" | "unknown";

/** Where a finished run's result goes; check() reconciles a key after a crash before any retry. */
export interface Destination {
  id: string;
  /** Local destination: its confirmed database row is delivery; notify only after commit. */
  afterCommit?(p: DeliveryPayload): void;
  repeatable?: boolean;
  publish(p: DeliveryPayload): Promise<string | undefined>;
  check(key: string): Promise<DeliveryCheck>;
}
