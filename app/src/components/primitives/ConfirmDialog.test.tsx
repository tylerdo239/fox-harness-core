// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { LocaleProvider } from "../../i18n/locale.tsx";
import { ConfirmDialogHost, confirmDialog } from "./ConfirmDialog.tsx";

afterEach(cleanup);

function mount() {
  render(
    <LocaleProvider>
      <ConfirmDialogHost />
    </LocaleProvider>,
  );
}

describe("confirmDialog", () => {
  it("resolves true on confirm, with a red danger dialog focused on Cancel", async () => {
    mount();
    let result: Promise<boolean> = Promise.resolve(false);
    act(() => {
      result = confirmDialog({ title: "Xoá?", message: "Chắc chưa?", confirmLabel: "Xoá", danger: true });
    });
    expect(document.querySelector(".fh-confirm-dialog.fh-confirm-danger")).not.toBeNull();
    expect(document.activeElement?.textContent).toBe("Huỷ");
    act(() => fireEvent.click(screen.getByText("Xoá", { selector: "button" })));
    await expect(result).resolves.toBe(true);
    expect(document.querySelector(".fh-confirm-dialog")).toBeNull();
  });

  it("resolves false on Escape and closes only itself", async () => {
    mount();
    let seen = 0;
    const onKey = () => seen++;
    window.addEventListener("keydown", onKey);
    let result: Promise<boolean> = Promise.resolve(true);
    act(() => {
      result = confirmDialog({ title: "Dọn?" });
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    });
    window.removeEventListener("keydown", onKey);
    await expect(result).resolves.toBe(false);
    expect(seen).toBe(0);
  });

  it("a second request cancels the first", async () => {
    mount();
    let first: Promise<boolean> = Promise.resolve(true);
    act(() => {
      first = confirmDialog({ title: "1" });
      void confirmDialog({ title: "2" });
    });
    await expect(first).resolves.toBe(false);
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe("2");
  });
});
