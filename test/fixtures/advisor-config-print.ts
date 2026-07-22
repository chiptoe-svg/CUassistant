// Fixture for advisor-config.test.ts.
//
// The advisor limits are module-level constants read from the environment at
// config load, so testing how a bad value is handled needs a fresh process —
// an in-process test cannot re-read them, and a dynamic re-import gets the
// cached config module and silently tests nothing.

import {
  ADVISOR_MAX_REQUEST_TOKENS,
  ADVISOR_MAX_ROUNDS,
  ADVISOR_TEMPERATURE,
  ADVISOR_TURN_TIMEOUT_MS,
} from "../../src/config.ts";

console.log(
  JSON.stringify({
    ADVISOR_MAX_ROUNDS,
    ADVISOR_TURN_TIMEOUT_MS,
    ADVISOR_TEMPERATURE,
    ADVISOR_MAX_REQUEST_TOKENS,
  }),
);
