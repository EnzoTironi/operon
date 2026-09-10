#!/usr/bin/env node
import { Effect } from "effect";

import { runCli } from "./index.js";

const code = await Effect.runPromise(runCli(process.argv.slice(2)));
process.exit(code);
