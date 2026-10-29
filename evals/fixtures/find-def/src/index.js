import { parseConfig } from "./config/load.js";
import { start } from "./server/start.js";

start(parseConfig(process.env));
