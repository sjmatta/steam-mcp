import { beforeAll, expect, it } from "vitest";
import { cdp } from "../../src/cdp/client.js";
import {
  getAppDetail,
  getCollection,
  listCollections,
  probeStores,
  snapshotLibrary,
} from "../../src/cdp/programs/read.js";
import { readInstalledApps } from "../../src/local/appmanifests.js";
import { readOfflineCollections } from "../../src/local/cloudstorage.js";
import { detectAccount } from "../../src/config.js";
import { e2e, ensureSteamReady } from "../helpers/e2e.js";

e2e("live Steam client: reads", () => {
  // Establish the state rather than assuming it: the suite must not depend on
  // how the machine was left.
  beforeAll(ensureSteamReady, 180_000);

  it("connects to the SharedJSContext target", () => {
    expect(cdp.connection?.target.title).toBeTruthy();
    expect(cdp.connection?.target.url).toMatch(/steamloopback\.host/);
  });

  it("snapshots the whole library in one evaluation", async () => {
    const started = Date.now();
    const snap = await cdp.evalInPage(snapshotLibrary, { includeTags: true }, "snapshot");
    expect(snap.rows.length).toBeGreaterThan(50);
    expect(snap.total).toBe(snap.rows.length);
    expect(Object.keys(snap.tagNames).length).toBeGreaterThan(20);
    // One evaluation, not per-app round trips.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  /**
   * The assertion that justifies ignoring overview.installed: the local-install
   * collection must agree exactly with the appmanifest files on disk.
   */
  it("agrees with the .acf files about what is installed", async () => {
    const snap = await cdp.evalInPage(snapshotLibrary, { includeTags: false }, "snapshot");
    const fromAcf = new Set(readInstalledApps().map((a) => a.appid));
    const fromClient = new Set(snap.installed);

    const onlyAcf = [...fromAcf].filter((a) => !fromClient.has(a));
    const onlyClient = [...fromClient].filter((a) => !fromAcf.has(a));
    expect({ onlyAcf, onlyClient }).toEqual({ onlyAcf: [], onlyClient: [] });
  });

  it("broadly agrees with the collections Steam flushed to disk", async () => {
    const live = await cdp.evalInPage(listCollections, undefined, "listCollections");
    const account = detectAccount()!;
    const offline = readOfflineCollections(account.accountId);

    const liveIds = new Set(live.filter((c) => !c.isSystem).map((c) => c.id));
    const offlineIds = new Set(offline.collections.filter((c) => !c.isSystem).map((c) => c.id));

    expect(liveIds.size).toBeGreaterThan(0);
    expect(offlineIds.size).toBeGreaterThan(0);

    // Neither side is strictly ahead: the file lags new collections, but it
    // also lags deletions, so it can list ones the client has already dropped.
    // What must hold is that they largely describe the same library.
    const overlap = [...liveIds].filter((id) => offlineIds.has(id)).length;
    const smaller = Math.min(liveIds.size, offlineIds.size);
    expect(overlap).toBeGreaterThanOrEqual(Math.floor(smaller * 0.8));
  });

  it("round-trips opaque collection ids containing + and *", async () => {
    const live = await cdp.evalInPage(listCollections, undefined, "listCollections");
    const opaque = live.find((c) => c.id.includes("*") || c.id.includes("+"));
    if (!opaque) return; // library may not have one
    const detail = await cdp.evalInPage(getCollection, { ref: opaque.id }, "getCollection");
    expect(detail.id).toBe(opaque.id);
  });

  it("returns detail for a real app", async () => {
    const installed = readInstalledApps();
    if (installed.length === 0) return;
    const detail = await cdp.evalInPage(
      getAppDetail,
      { appid: installed[0]!.appid },
      "getAppDetail",
    );
    expect(detail.appid).toBe(installed[0]!.appid);
    expect(detail.installed).toBe(true);
    expect(detail.name).toBeTruthy();
  });

  /**
   * Concurrent evaluations against one target crash the Steam UI. This fires a
   * burst through the public client and then checks Steam survived.
   */
  it("survives a burst of concurrent evaluations", async () => {
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        cdp.evalInPage(probeStores, undefined, `concurrent-${i}`),
      ),
    );
    expect(results).toHaveLength(10);
    expect(new Set(results.map((r) => r.appCount)).size).toBe(1);

    const after = await cdp.evalInPage(probeStores, undefined, "after-burst");
    expect(after.collectionStore).toBe(true);
    expect(after.appStore).toBe(true);
  });
});
