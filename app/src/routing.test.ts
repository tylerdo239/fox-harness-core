import { describe, expect, it } from "vitest";

import { chatPath, hubPath, initialSessionTarget, isDataStudioUrl, routeFromUrl, sessionIdFromUrl } from "./routing.ts";

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const P = "7c9e6679-7425-40de-944b-e07fc1f90ae7";

describe("routeFromUrl", () => {
  it.each([
    ["/", { view: "chat" }],
    [`/chat/${ID}`, { view: "chat", sessionId: ID }],
    ["/admin/usage", { view: "adminUsage" }],
    ["/my-skills", { view: "skills" }],
    ["/data-studio", { view: "dataStudio" }],
    [`/data-studio/chat/${ID}`, { view: "dataStudio", sessionId: ID }],
    ["/data", { view: "hub", projectId: null }],
    [`/data/${P}`, { view: "hub", projectId: P }],
    [`/data/chat/${ID}`, { view: "dataChat", projectId: null, sessionId: ID }],
    [`/data/${P}/chat/${ID}`, { view: "dataChat", projectId: P, sessionId: ID }],
  ])("%s", (path, route) => {
    expect(routeFromUrl(path)).toEqual(route);
  });

  it.each(["/chat/not-an-id", "/skills", "/data-studio/x", "/data/x", `/data/${P}/chat`, "/admin", "/nope"])(
    "%s is no route",
    (path) => {
      expect(routeFromUrl(path)).toBeUndefined();
    },
  );
});

describe("session targets", () => {
  it("a chat URL resumes that session", () => {
    expect(sessionIdFromUrl(`/data/${P}/chat/${ID}`)).toBe(ID);
    expect(initialSessionTarget(`/chat/${ID}`)).toEqual({ path: ID });
  });
  it("pages and hubs carry no session", () => {
    expect(sessionIdFromUrl(`/data/${P}`)).toBeUndefined();
    expect(sessionIdFromUrl("/admin/usage")).toBeUndefined();
  });
  it("a fresh Data Studio visit asks for the data-studio flow", () => {
    expect(initialSessionTarget("/data-studio")).toEqual({ path: "new", flow: "data-studio" });
    expect(initialSessionTarget("/")).toEqual({ path: "new", flow: undefined });
    expect(isDataStudioUrl("/data-studio-x")).toBe(false);
  });
});

describe("paths", () => {
  it("builds each area's chat URL", () => {
    expect(chatPath(ID, { area: "chat" })).toBe(`/chat/${ID}`);
    expect(chatPath(ID, { area: "data-studio" })).toBe(`/data-studio/chat/${ID}`);
    expect(chatPath(ID, { area: "data", projectId: P })).toBe(`/data/${P}/chat/${ID}`);
    expect(chatPath(ID, { area: "data", projectId: null })).toBe(`/data/chat/${ID}`);
    expect(hubPath(null)).toBe("/data");
  });
  it("every built path parses back", () => {
    for (const place of [{ area: "chat" }, { area: "data-studio" }, { area: "data", projectId: P }] as const) {
      expect(sessionIdFromUrl(chatPath(ID, place))).toBe(ID);
    }
  });
});
