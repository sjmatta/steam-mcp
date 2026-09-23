import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getAppDetail,
  getCollection,
  listCollections,
  probeStores,
  snapshotLibrary,
} from "../../src/cdp/programs/read.js";
import { collectionOp, openWizard, setAppFlags } from "../../src/cdp/programs/write.js";
import { FakeSteam, defaultFakeSteam } from "../helpers/fake-steam.js";

let steam: FakeSteam;

beforeEach(() => {
  steam = defaultFakeSteam();
  steam.install();
});

afterEach(() => {
  FakeSteam.uninstall();
});

describe("probeStores", () => {
  it("reports the stores as ready", () => {
    const probe = probeStores();
    expect(probe).toMatchObject({ collectionStore: true, appStore: true, steamClient: true });
    expect(probe.appCount).toBe(5);
    expect(probe.collectionCount).toBe(3);
  });

  it("reports missing stores instead of throwing while Steam is booting", () => {
    FakeSteam.uninstall();
    expect(probeStores()).toMatchObject({
      collectionStore: false,
      appStore: false,
      steamClient: false,
      appCount: 0,
    });
  });
});

describe("snapshotLibrary", () => {
  it("returns columnar rows for every app kind", () => {
    const snap = snapshotLibrary({ includeTags: true });
    expect(snap.total).toBe(5);
    expect(snap.cols).toContain("appid");
    expect(snap.rows).toHaveLength(5);
  });

  it("takes installed state from local-install, not overview.installed", () => {
    // Every fake overview reports installed:true, exactly like the real client.
    const snap = snapshotLibrary({ includeTags: false });
    expect(snap.installed.sort((a, b) => a - b)).toEqual([212680, 427520]);
  });

  it("resolves tag ids into a shared dictionary", () => {
    const snap = snapshotLibrary({ includeTags: true });
    expect(snap.tagNames["9"]).toBe("Strategy");
    expect(snap.appTags["427520"]).toEqual([9, 492]);
  });

  it("omits per-app tags when they were not requested", () => {
    expect(snapshotLibrary({ includeTags: false }).appTags).toEqual({});
  });

  it("marks hidden apps from the hidden collection", async () => {
    await setAppFlags({ appids: [620], flag: "hidden", value: true });
    const snap = snapshotLibrary({ includeTags: false });
    const hiddenIdx = snap.cols.indexOf("hidden");
    const row = snap.rows.find((r) => r[0] === 620)!;
    expect(row[hiddenIdx]).toBe(1);
  });

  it("throws a recognisable error when the stores are absent", () => {
    FakeSteam.uninstall();
    expect(() => snapshotLibrary({ includeTags: false })).toThrow("STORES_NOT_READY");
  });
});

describe("listCollections", () => {
  it("includes user, system and type collections without duplicates", () => {
    const cols = listCollections();
    const ids = cols.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("uc-static");
    expect(ids).toContain("favorite");
    expect(ids).toContain("type-games");
  });

  it("flags dynamic collections and marks them uneditable", () => {
    const dynamic = listCollections().find((c) => c.id === "uc-dynamic")!;
    expect(dynamic.isDynamic).toBe(true);
    expect(dynamic.isEditable).toBe(false);
  });

  it("marks static user collections editable", () => {
    const staticCollection = listCollections().find((c) => c.id === "uc-static")!;
    expect(staticCollection.isDynamic).toBe(false);
    expect(staticCollection.isEditable).toBe(true);
    expect(staticCollection.isSystem).toBe(false);
  });

  it("marks Steam's own collections as system and uneditable", () => {
    const fav = listCollections().find((c) => c.id === "favorite")!;
    expect(fav.isSystem).toBe(true);
    expect(fav.isEditable).toBe(false);
  });
});

describe("getCollection", () => {
  it("resolves by id", () => {
    expect(getCollection({ ref: "uc-static" })).toMatchObject({
      id: "uc-static",
      name: "Roguelike / Roguelite",
      appids: [212680],
    });
  });

  it("resolves by exact name", () => {
    expect(getCollection({ ref: "Roguelike / Roguelite" }).id).toBe("uc-static");
  });

  it("resolves an opaque id containing + and * verbatim", () => {
    expect(getCollection({ ref: "uc-8qBpJj1*+Borh" }).appids).toEqual([427520]);
  });

  it("reports a missing collection", () => {
    expect(() => getCollection({ ref: "no-such-thing" })).toThrow("COLLECTION_NOT_FOUND");
  });
});

describe("getAppDetail", () => {
  it("returns merged detail including collection membership", () => {
    const detail = getAppDetail({ appid: 427520 });
    expect(detail).toMatchObject({ appid: 427520, name: "Factorio", installed: true });
    expect(detail.tags).toContain("Strategy");
    expect(detail.collections.map((c) => c.name)).toContain("City Builder & Management");
  });

  it("reflects favorite and hidden state", async () => {
    await setAppFlags({ appids: [620], flag: "favorite", value: true });
    await setAppFlags({ appids: [620], flag: "hidden", value: true });
    const detail = getAppDetail({ appid: 620 });
    expect(detail.favorite).toBe(true);
    expect(detail.hidden).toBe(true);
  });

  it("reports an unknown appid", () => {
    expect(() => getAppDetail({ appid: 999999 })).toThrow("APP_NOT_FOUND");
  });
});

describe("collectionOp: create", () => {
  it("creates a static collection seeded with apps", async () => {
    const result = await collectionOp({ op: "create", name: "New Set", appids: [620, 427520] });
    expect(result.created).toBe(true);
    expect(result.reused).toBe(false);
    expect(result.after.sort((a, b) => a - b)).toEqual([620, 427520]);
    expect(steam.saveCalls.length).toBeGreaterThan(0);
  });

  /**
   * The destructive-collision regression. Steam's SaveCollection deletes an
   * existing deletable collection with the same display name, so creating must
   * resolve-and-reuse rather than blind-create.
   */
  it("reuses an existing collection of the same name instead of destroying it", async () => {
    const before = steam.membership("uc-static");
    const result = await collectionOp({
      op: "create",
      name: "Roguelike / Roguelite",
      appids: [620],
    });

    expect(result.reused).toBe(true);
    expect(result.created).toBe(false);
    expect(result.id).toBe("uc-static");
    // The original member survived and the new one was added.
    expect(result.after.sort((a, b) => a - b)).toEqual([...before, 620].sort((a, b) => a - b));
    expect(steam.collectionIds()).toContain("uc-static");
  });

  it("can be told to fail rather than reuse", async () => {
    await expect(
      collectionOp({ op: "create", name: "Roguelike / Roguelite", onExisting: "fail" }),
    ).rejects.toThrow("NAME_COLLISION");
  });

  it("refuses a name reserved by Steam", async () => {
    await expect(collectionOp({ op: "create", name: "Favorites" })).rejects.toThrow(
      "NAME_COLLISION",
    );
  });

  it("requires a non-empty name", async () => {
    await expect(collectionOp({ op: "create", name: "" })).rejects.toThrow("INVALID_NAME");
  });

  it("reports unresolvable appids rather than dropping them silently", async () => {
    const result = await collectionOp({ op: "create", name: "Partial", appids: [620, 42424242] });
    expect(result.after).toEqual([620]);
    expect(result.skipped).toEqual([
      { appid: 42424242, reason: "not in library (unowned or unknown appid)" },
    ]);
  });

  it("previews a creation without writing anything", async () => {
    const before = steam.collectionIds().length;
    const result = await collectionOp({
      op: "create",
      name: "Preview Only",
      appids: [620],
      dryRun: true,
    });
    expect(result.added).toEqual([620]);
    expect(steam.collectionIds().length).toBe(before);
    expect(steam.saveCalls).toEqual([]);
  });
});

describe("collectionOp: membership", () => {
  it("adds apps and persists", async () => {
    const result = await collectionOp({ op: "add", ref: "uc-static", appids: [620] });
    expect(result.added).toEqual([620]);
    expect(steam.membership("uc-static").sort((a, b) => a - b)).toEqual([620, 212680]);
  });

  it("removes apps", async () => {
    const result = await collectionOp({ op: "remove", ref: "uc-static", appids: [212680] });
    expect(result.removed).toEqual([212680]);
    expect(steam.membership("uc-static")).toEqual([]);
  });

  it("replaces the whole membership", async () => {
    const result = await collectionOp({ op: "replace", ref: "uc-static", appids: [620, 427520] });
    expect(result.removed).toEqual([212680]);
    expect(result.after.sort((a, b) => a - b)).toEqual([620, 427520]);
  });

  it("projects the resulting membership on a dry-run add", async () => {
    // A preview that reports no change is useless for confirming intent.
    const result = await collectionOp({
      op: "add",
      ref: "uc-static",
      appids: [620],
      dryRun: true,
    });
    expect(result.added).toEqual([620]);
    expect(result.after.sort((a, b) => a - b)).toEqual([620, 212680]);
    expect(steam.membership("uc-static")).toEqual([212680]); // unchanged
  });

  it("projects removals on a dry-run remove", async () => {
    const result = await collectionOp({
      op: "remove",
      ref: "uc-static",
      appids: [212680],
      dryRun: true,
    });
    expect(result.removed).toEqual([212680]);
    expect(result.after).toEqual([]);
    expect(steam.membership("uc-static")).toEqual([212680]);
  });

  it("projects a full replace on a dry run", async () => {
    const result = await collectionOp({
      op: "replace",
      ref: "uc-static",
      appids: [620],
      dryRun: true,
    });
    expect(result.removed).toEqual([212680]);
    expect(result.added).toEqual([620]);
    expect(steam.membership("uc-static")).toEqual([212680]);
  });

  it("adding an app already present is a no-op, not a duplicate", async () => {
    const result = await collectionOp({ op: "add", ref: "uc-static", appids: [212680] });
    expect(result.added).toEqual([]);
    expect(steam.membership("uc-static")).toEqual([212680]);
  });

  /**
   * Writes to a dynamic collection are silently reverted by Steam on the next
   * recompute, so they must be refused loudly instead.
   */
  it("refuses to write to a dynamic collection", async () => {
    await expect(collectionOp({ op: "add", ref: "uc-dynamic", appids: [620] })).rejects.toThrow(
      "DYNAMIC_COLLECTION",
    );
  });

  it("refuses to write to a system collection", async () => {
    await expect(collectionOp({ op: "add", ref: "favorite", appids: [620] })).rejects.toThrow(
      /DYNAMIC_COLLECTION|NOT_EDITABLE/,
    );
  });

  it("reports a missing collection", async () => {
    await expect(collectionOp({ op: "add", ref: "nope", appids: [620] })).rejects.toThrow(
      "COLLECTION_NOT_FOUND",
    );
  });
});

describe("collectionOp: rename and delete", () => {
  it("renames while keeping the id, because shelves reference ids", async () => {
    const result = await collectionOp({ op: "rename", ref: "uc-static", name: "Renamed" });
    expect(result.id).toBe("uc-static");
    expect(result.name).toBe("Renamed");
    expect(result.after).toEqual([212680]);
  });

  it("refuses to rename a system collection", async () => {
    await expect(collectionOp({ op: "rename", ref: "favorite", name: "Nope" })).rejects.toThrow(
      "NOT_EDITABLE",
    );
  });

  it("deletes a user collection", async () => {
    const result = await collectionOp({ op: "delete", ref: "uc-static" });
    expect(result.before).toEqual([212680]);
    expect(result.after).toEqual([]);
    expect(steam.collectionIds()).not.toContain("uc-static");
  });

  it("refuses to delete a system collection", async () => {
    await expect(collectionOp({ op: "delete", ref: "hidden" })).rejects.toThrow("NOT_EDITABLE");
  });

  it("previews a delete without removing anything", async () => {
    const result = await collectionOp({ op: "delete", ref: "uc-static", dryRun: true });
    expect(result.before).toEqual([212680]);
    expect(result.after).toEqual([]); // projected
    expect(steam.collectionIds()).toContain("uc-static");
  });
});

describe("setAppFlags", () => {
  /**
   * Regression for the flag bug. Steam's AddOrRemoveApp takes RAW APPIDS and
   * maps them through GetAppOverviewByAppID itself, filtering only `undefined`.
   * Passing AppOverviews yields a null that survives that filter and crashes
   * AddApps with "Cannot read properties of null (reading 'appid')" — and for
   * ids that return undefined instead, the call silently does nothing.
   */
  it("actually applies the hidden flag", async () => {
    const result = await setAppFlags({ appids: [620], flag: "hidden", value: true });
    expect(result.applied).toEqual([620]);
    expect(steam.membership("hidden")).toContain(620);
  });

  it("actually applies the favorite flag", async () => {
    await setAppFlags({ appids: [427520], flag: "favorite", value: true });
    expect(steam.membership("favorite")).toContain(427520);
  });

  it("round-trips a flag back off", async () => {
    await setAppFlags({ appids: [620], flag: "hidden", value: true });
    expect(steam.membership("hidden")).toContain(620);
    await setAppFlags({ appids: [620], flag: "hidden", value: false });
    expect(steam.membership("hidden")).not.toContain(620);
  });

  it("demonstrates why overviews must not be passed to Steam's flag API", async () => {
    // Passing overviews is what the buggy implementation did. The fake
    // reproduces Steam's exact filter, so this is the real failure mode.
    const overviews = [{ appid: 620 } as unknown];
    expect(() =>
      (globalThis as any).collectionStore.AddOrRemoveApp(overviews, true, "hidden"),
    ).toThrow(/Cannot read properties of null/);
    // And the correct call, with raw ids, succeeds.
    expect(() =>
      (globalThis as any).collectionStore.AddOrRemoveApp([620], true, "hidden"),
    ).not.toThrow();
  });

  it("filters unresolvable appids before they reach Steam", async () => {
    const result = await setAppFlags({ appids: [620, 42424242], flag: "hidden", value: true });
    expect(result.applied).toEqual([620]);
    expect(result.skipped).toEqual([42424242]);
    expect(steam.membership("hidden")).toEqual([620]);
  });

  it("previews without applying", async () => {
    const result = await setAppFlags({
      appids: [620],
      flag: "hidden",
      value: true,
      dryRun: true,
    });
    expect(result.applied).toEqual([620]);
    expect(steam.membership("hidden")).toEqual([]);
  });

  it("returns the resulting collection membership", async () => {
    const result = await setAppFlags({ appids: [620, 427520], flag: "favorite", value: true });
    expect(result.after.sort((a, b) => a - b)).toEqual([620, 427520]);
  });
});

describe("openWizard", () => {
  it("opens the install wizard for an app that is not installed", async () => {
    const result = await openWizard({ appid: 620, kind: "install" });
    expect(result).toMatchObject({ opened: true, alreadyInstalled: false, name: "Portal 2" });
    expect(steam.wizardCalls).toEqual([{ kind: "install", appids: [620] }]);
  });

  it("does not open an install wizard for an installed app", async () => {
    const result = await openWizard({ appid: 427520, kind: "install" });
    expect(result).toMatchObject({ opened: false, alreadyInstalled: true });
    expect(steam.wizardCalls).toEqual([]);
  });

  it("opens the uninstall wizard only for an installed app", async () => {
    expect(await openWizard({ appid: 427520, kind: "uninstall" })).toMatchObject({ opened: true });
    expect(steam.wizardCalls).toEqual([{ kind: "uninstall", appids: [427520] }]);
  });

  it("does not open an uninstall wizard for an app that is not installed", async () => {
    const result = await openWizard({ appid: 620, kind: "uninstall" });
    expect(result.opened).toBe(false);
    expect(steam.wizardCalls).toEqual([]);
  });

  it("reports an unknown appid", async () => {
    await expect(openWizard({ appid: 999999, kind: "install" })).rejects.toThrow("APP_NOT_FOUND");
  });
});
