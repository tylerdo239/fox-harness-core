import { describe, expect, it } from "vitest";

import { computeColumns, SIDEBAR_EXPANDED_WIDTH } from "./layout.ts";

describe("computeColumns", () => {
  it("gives the sidebar its width and the rest to the centre", () => {
    expect(computeColumns(1440, SIDEBAR_EXPANDED_WIDTH, 0)).toEqual({ sidebar: 280, center: 1160, details: 0 });
  });
  it("a collapsed sidebar is the 56px rail", () => {
    expect(computeColumns(1440, 0, 0).sidebar).toBe(56);
  });
  it("too narrow: the sidebar keeps its width and the centre never goes negative", () => {
    expect(computeColumns(200, SIDEBAR_EXPANDED_WIDTH, 0)).toEqual({ sidebar: 280, center: 0, details: 0 });
    expect(computeColumns(800, SIDEBAR_EXPANDED_WIDTH, 0)).toEqual({ sidebar: 280, center: 520, details: 0 });
  });
});
