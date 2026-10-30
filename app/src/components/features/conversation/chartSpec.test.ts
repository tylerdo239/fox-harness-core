import { describe, expect, it } from "vitest";

import { categoryOf, chartTitle, colorFor, labelFor, resolveChart, SERIES_COLORS, toNumber } from "./chartSpec.ts";

describe("chartSpec", () => {
  it("folds saved edits over the recommended spec", () => {
    const chart = resolveChart({ title: "A", x: "d", y: ["v"], title_override: "B", x_override: "m", y_override: ["w"] });
    expect(chart).toMatchObject({ title: "B", x: "m", y: ["w"] });
    expect(resolveChart({ y: ["v"], y_override: [] }).y).toEqual(["v"]);
  });
  it("labels, colors, numbers, categories", () => {
    expect(labelFor("f", { f: "Field" })).toBe("Field");
    expect(labelFor("f")).toBe("f");
    expect(colorFor({ color_overrides: { b: "#000" } }, "b", 1)).toBe("#000");
    expect(colorFor({}, "c", 7)).toBe(SERIES_COLORS[1]);
    expect(toNumber("12.5")).toBe(12.5);
    expect(toNumber("")).toBeNull();
    expect(categoryOf(true)).toBe("true");
    expect(categoryOf(null)).toBe("—");
  });
  it("shows the UI's own label for the legacy raw-rows title", () => {
    expect(chartTitle({ type: "table", title: "Bảng dữ liệu" }, "Data table")).toBe("Data table");
    expect(chartTitle({ type: "bar", title: "Bảng dữ liệu" }, "Data table")).toBe("Bảng dữ liệu");
  });
});
