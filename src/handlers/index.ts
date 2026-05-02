// Handler barrel — side-effect imports that register handlers.
//
// Adding a capability:
//   1. Create src/handlers/<name>.ts that calls registerHandler(...)
//   2. Add its import line below
//   3. Declare its scopes in src/permissions.ts
//
// Removing a capability: delete the file and the import line.

import "./triage.js";
