// Reads settings from the environment.
export function parseConfig(env) {
  return { port: Number(env.PORT ?? 3000), debug: env.DEBUG === "1" };
}
