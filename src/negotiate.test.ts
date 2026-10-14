import { expect, test } from "bun:test";
import { negotiateSize } from "./server";

// Two tabs attached to one session: the narrower one used to hard-wrap the
// wider one's lines mid-word because the last resize won. The session must run
// at the smallest size any attached tab can show.
test("the session runs at the smallest attached size", () => {
  const current = { cols: 139, rows: 73 };
  expect(negotiateSize([{ cols: 139, rows: 73 }, { cols: 110, rows: 80 }], current)).toEqual({
    cols: 110,
    rows: 73,
  });
  expect(negotiateSize([{ cols: 200, rows: 50 }], current)).toEqual({ cols: 200, rows: 50 });
});

test("with nobody attached the current size stands, and tiny caps are clamped", () => {
  const current = { cols: 120, rows: 40 };
  expect(negotiateSize([], current)).toEqual(current);
  expect(negotiateSize([{ cols: NaN, rows: 3 }], current)).toEqual(current);
  expect(negotiateSize([{ cols: 1, rows: 1 }], current)).toEqual({ cols: 10, rows: 2 });
  expect(negotiateSize([{ cols: 80.9, rows: 24.2 }], current)).toEqual({ cols: 80, rows: 24 });
});
