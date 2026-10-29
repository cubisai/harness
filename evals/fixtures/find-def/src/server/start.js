// Starts the server with a parsed config (see parseConfig).
export function start(config) {
  return `listening on ${config.port}`;
}
