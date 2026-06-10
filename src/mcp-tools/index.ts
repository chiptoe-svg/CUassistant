// Credentialed (MS365 + orchestration + send) barrel — Clemson/public tools live in index-public.ts
// Imports each tool module for its side-effect `registerTools([...])` call.
// Add a new credentialed tool group by creating a file in this directory and
// appending its import here. No central tool list.

import "./mail-read.js";
import "./calendar-read.js";
import "./todo-tasks.js";
import "./mail-folders.js";
import "./mail-write.js";
import "./calendar-write.js";
import "./sheets.js";
import "./docs.js";
import "./host-orchestration.js";
