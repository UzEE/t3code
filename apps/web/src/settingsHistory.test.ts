import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
} from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { leaveSettings, withSettingsHistory } from "./settingsHistory";

describe("settings history", () => {
  it("leaves nested Settings history at its exact origin without deleting forward entries", () => {
    const history = withSettingsHistory(
      createMemoryHistory({
        initialEntries: ["/env", "/env/old", "/env/current?diff=1#message"],
      }),
    );
    history.push("/settings");
    history.push("/settings/open-source-licenses");

    history.back();
    expect(history.location.href).toBe("/settings");
    history.forward();
    expect(history.location.href).toBe("/settings/open-source-licenses");

    leaveSettings(history);

    expect(history.location.href).toBe("/env/current?diff=1#message");
    history.forward();
    expect(history.location.href).toBe("/settings");
    history.forward();
    expect(history.location.href).toBe("/settings/open-source-licenses");
    leaveSettings(history);
    expect(history.location.href).toBe("/env/current?diff=1#message");
  });

  it("carries the origin through the Settings index redirect", async () => {
    const root = createRootRoute();
    const projects = createRoute({ getParentRoute: () => root, path: "projects" });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "settings",
      beforeLoad: ({ location }) => {
        if (location.pathname === "/settings") {
          throw redirect({ to: "/settings/general", replace: true });
        }
      },
    });
    const general = createRoute({ getParentRoute: () => settings, path: "general" });
    const history = withSettingsHistory(createMemoryHistory({ initialEntries: ["/projects"] }));
    const router = createRouter({
      routeTree: root.addChildren([projects, settings.addChildren([general])]),
      history,
    });
    await router.load();

    await router.navigate({ to: "/settings" });
    const redirectOptions = router.state.redirect?.options;
    expect(redirectOptions).not.toBeUndefined();
    if (!redirectOptions) throw new Error("Expected the Settings index to redirect");
    await router.navigate(redirectOptions);
    leaveSettings(history);

    expect(history.location.href).toBe("/projects");
    history.forward();
    expect(history.location.href).toBe("/settings/general");
  });

  it("keeps the first origin when Settings is opened again and preserves navigation state", () => {
    const history = withSettingsHistory(
      createMemoryHistory({ initialEntries: ["/threads/active"] }),
    );
    history.push("/settings", { source: "sidebar" });
    history.push("/settings?source=keyboard", { source: "keyboard" });
    history.replace("/settings/general#theme", { highlight: "theme" });

    expect(history.location.state).toMatchObject({
      __T3_settingsReturnIndex: 0,
      highlight: "theme",
    });
    leaveSettings(history);

    expect(history.location.href).toBe("/threads/active");
  });

  it("records a new origin for each outside-to-Settings visit", () => {
    const history = withSettingsHistory(createMemoryHistory({ initialEntries: ["/env/first"] }));
    history.push("/settings/general");
    leaveSettings(history);
    history.push("/projects");
    history.push("/settings/appearance");
    leaveSettings(history);
    expect(history.location.href).toBe("/projects");

    history.push("/projects/repository/extra");
    history.push("/settings/keybindings");

    leaveSettings(history);

    expect(history.location.href).toBe("/projects/repository/extra");
  });

  it("uses a persisted return point after reload", () => {
    const browserHistory = createMemoryHistory({ initialEntries: ["/env/reloaded"] });
    browserHistory.push("/settings/general", {
      __T3_settingsReturnIndex: 0,
      persistedMetadata: "kept",
    });
    const reloadedHistory = withSettingsHistory(browserHistory);

    expect(reloadedHistory.location.state).toMatchObject({ persistedMetadata: "kept" });
    leaveSettings(reloadedHistory);

    expect(reloadedHistory.location.href).toBe("/env/reloaded");
  });

  it.each([
    { entry: "outside Settings", startInsideSettings: false },
    { entry: "from Settings", startInsideSettings: true },
  ])(
    "returns to the original page after the legacy project redirect $entry",
    async ({ startInsideSettings }) => {
      const history = withSettingsHistory(
        createMemoryHistory({ initialEntries: ["/env/current"] }),
      );
      if (startInsideSettings) history.push("/settings/general");

      const root = createRootRoute();
      const environment = createRoute({ getParentRoute: () => root, path: "env/$threadId" });
      const settings = createRoute({ getParentRoute: () => root, path: "settings" });
      const projects = createRoute({ getParentRoute: () => settings, path: "projects" });
      const legacyProject = createRoute({
        getParentRoute: () => root,
        path: "projects/$projectKey",
        beforeLoad: () => {
          throw redirect({ to: "/settings/projects", replace: true });
        },
      });
      const router = createRouter({
        routeTree: root.addChildren([environment, settings.addChildren([projects]), legacyProject]),
        history,
      });
      await router.load();

      await router.navigate({
        to: "/projects/$projectKey",
        params: { projectKey: "repository:t3code" },
      });
      const redirectOptions = router.state.redirect?.options;
      expect(redirectOptions).not.toBeUndefined();
      if (!redirectOptions) throw new Error("Expected the legacy project route to redirect");
      await router.navigate(redirectOptions);
      leaveSettings(history);

      expect(history.location.href).toBe("/env/current");
    },
  );

  it("replaces a direct Settings entry with home when no valid return point exists", () => {
    const history = withSettingsHistory(
      createMemoryHistory({ initialEntries: ["/settings/general"] }),
    );

    leaveSettings(history);

    expect(history.location.href).toBe("/");
    expect(history.length).toBe(1);
    history.forward();
    expect(history.location.href).toBe("/");
  });
});
