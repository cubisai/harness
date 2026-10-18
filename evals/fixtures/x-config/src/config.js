// Default server configuration.
export const config = {
  host: "127.0.0.1",
  port: 3000,
  logLevel: "info",
};

export function baseUrl() {
  return `http://${config.host}:${config.port}`;
}
