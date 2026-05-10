// MCP tools barrel — imports each tool module for its side-effect
// `registerTools([...])` call. Add a new tool group by creating a file in
// this directory and appending its import here. No central tool list.

import "./mail-read.js";
import "./calendar-read.js";
import "./todo-tasks.js";
import "./mail-write.js";
import "./calendar-write.js";
import "./host-orchestration.js";
