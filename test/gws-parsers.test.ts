import assert from "node:assert/strict";
import test from "node:test";

import {
  parseSheetValues,
  parseSpreadsheetInfo,
} from "../src/clemson-sheets.ts";
import { parseCreatedDoc, parseDocText } from "../src/clemson-docs.ts";
import { gwsResponseError } from "../src/gws-cli.ts";

test("parseSheetValues yields a 2-D string grid", () => {
  const j = JSON.stringify({
    range: "Sheet1!A1:B2",
    values: [
      ["Name", "Score"],
      ["Alice", 100],
    ],
  });
  const v = parseSheetValues(j);
  assert.equal(v.range, "Sheet1!A1:B2");
  assert.deepEqual(v.values, [
    ["Name", "Score"],
    ["Alice", "100"],
  ]);
  assert.deepEqual(parseSheetValues("{}").values, []); // no values -> empty
});

test("parseSpreadsheetInfo extracts title + tabs", () => {
  const j = JSON.stringify({
    properties: { title: "Budget" },
    sheets: [
      { properties: { sheetId: 0, title: "2026" } },
      { properties: { sheetId: 7, title: "Notes" } },
    ],
  });
  const info = parseSpreadsheetInfo(j);
  assert.equal(info.title, "Budget");
  assert.deepEqual(info.tabs, [
    { title: "2026", sheetId: 0 },
    { title: "Notes", sheetId: 7 },
  ]);
});

test("parseDocText walks paragraphs and table cells", () => {
  const j = JSON.stringify({
    body: {
      content: [
        { paragraph: { elements: [{ textRun: { content: "Hello " } }] } },
        { paragraph: { elements: [{ textRun: { content: "world.\n" } }] } },
        {
          table: {
            tableRows: [
              {
                tableCells: [
                  {
                    content: [
                      {
                        paragraph: {
                          elements: [{ textRun: { content: "cell" } }],
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    },
  });
  assert.equal(parseDocText(j), "Hello world.\ncell");
});

test("parseCreatedDoc pulls the new document id", () => {
  assert.deepEqual(
    parseCreatedDoc(JSON.stringify({ documentId: "DOC123", title: "Notes" })),
    { documentId: "DOC123", title: "Notes" },
  );
});

test("gwsResponseError surfaces an error envelope, ignores success", () => {
  assert.match(
    gwsResponseError(
      JSON.stringify({ error: { code: 401, message: "invalid_grant" } }),
    ) ?? "",
    /invalid_grant/,
  );
  assert.equal(
    gwsResponseError(JSON.stringify({ range: "A1", values: [] })),
    null,
  );
  assert.equal(gwsResponseError("not json"), null);
});
