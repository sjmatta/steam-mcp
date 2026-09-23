import { afterAll, beforeAll, expect, it } from "vitest";
import { cdp } from "../../src/cdp/client.js";
import { getCollection, listCollections } from "../../src/cdp/programs/read.js";
import { collectionOp, setAppFlags } from "../../src/cdp/programs/write.js";
import { readInstalledApps } from "../../src/local/appmanifests.js";
import { SCRATCH_PREFIX, e2eWrites, ensureSteamReady, scratchName } from "../helpers/e2e.js";

/**
 * These create and delete real collections in the user's library.
 *
 * Safety model: every collection is named with a per-run unique scratch prefix
 * so it can never collide with a real one (which would trigger Steam's
 * same-name deletion), everything is removed in afterAll, and the suite asserts
 * that no pre-existing collection changed.
 */
e2eWrites("live Steam client: writes", () => {
  let baseline: Map<string, string>;
  let testAppids: number[];

  const snapshotCollections = async (): Promise<Map<string, string>> => {
    const cols = await cdp.evalInPage(listCollections, undefined, "snapshot-collections");
    return new Map(cols.map((c) => [c.id, `${c.name}:${c.appCount}`]));
  };

  const cleanupScratch = async (): Promise<void> => {
    const cols = await cdp.evalInPage(listCollections, undefined, "cleanup-scan");
    for (const col of cols.filter((c) => c.name.startsWith(SCRATCH_PREFIX))) {
      await cdp.evalInPage(collectionOp, { op: "delete", ref: col.id }, "cleanup");
    }
  };

  beforeAll(async () => {
    await ensureSteamReady();

    const existing = await cdp.evalInPage(listCollections, undefined, "precheck");
    const strays = existing.filter((c) => c.name.startsWith(SCRATCH_PREFIX));
    if (strays.length > 0) {
      // Refuse to start with leftovers, rather than risk deleting something real.
      throw new Error(
        `Leftover scratch collections present: ${strays.map((s) => s.name).join(", ")}`,
      );
    }

    const installed = readInstalledApps();
    if (installed.length < 3) throw new Error("Need at least 3 installed games for write tests.");
    testAppids = installed.slice(0, 3).map((a) => a.appid);
    baseline = await snapshotCollections();
  }, 180_000);

  afterAll(async () => {
    await cleanupScratch();
    const final = await snapshotCollections();
    const drift: string[] = [];
    for (const [id, signature] of baseline) {
      if (final.get(id) !== signature)
        drift.push(`${id}: ${signature} -> ${final.get(id) ?? "GONE"}`);
    }
    // Any change to a pre-existing collection is a failure of this suite.
    expect(drift).toEqual([]);
    expect([...final.keys()].filter((id) => id.startsWith("uc-")).length).toBeGreaterThan(0);
  });

  it("runs a full collection lifecycle", async () => {
    const name = scratchName();
    const [a, b, c] = testAppids as [number, number, number];

    const created = await cdp.evalInPage(
      collectionOp,
      { op: "create", name, appids: [a, b] },
      "create",
    );
    expect(created.created).toBe(true);
    expect(created.after.sort()).toEqual([a, b].sort());

    const added = await cdp.evalInPage(
      collectionOp,
      { op: "add", ref: created.id, appids: [c] },
      "add",
    );
    expect(added.after).toHaveLength(3);

    const removed = await cdp.evalInPage(
      collectionOp,
      { op: "remove", ref: created.id, appids: [b] },
      "remove",
    );
    expect(removed.after).toHaveLength(2);

    const replaced = await cdp.evalInPage(
      collectionOp,
      { op: "replace", ref: created.id, appids: [a] },
      "replace",
    );
    expect(replaced.after).toEqual([a]);

    // Re-read in a separate evaluation: this is what proves Save() landed
    // rather than the change existing only on the in-memory handle.
    const reread = await cdp.evalInPage(getCollection, { ref: created.id }, "reread");
    expect(reread.appids).toEqual([a]);

    const renamed = await cdp.evalInPage(
      collectionOp,
      { op: "rename", ref: created.id, name: `${name}-r` },
      "rename",
    );
    expect(renamed.id).toBe(created.id); // ids are referenced by library shelves
    expect(renamed.name).toBe(`${name}-r`);

    await cdp.evalInPage(collectionOp, { op: "delete", ref: created.id }, "delete");
    const after = await cdp.evalInPage(listCollections, undefined, "verify-delete");
    expect(after.some((col) => col.id === created.id)).toBe(false);
  });

  /**
   * The destructive-collision regression, against the real client: Steam
   * deletes a same-named collection when saving a new one.
   */
  it("reuses a same-named collection instead of destroying it", async () => {
    const name = scratchName("-collision");
    const [a, b] = testAppids as [number, number];

    const first = await cdp.evalInPage(collectionOp, { op: "create", name, appids: [a] }, "first");
    const second = await cdp.evalInPage(
      collectionOp,
      { op: "create", name, appids: [b] },
      "second",
    );

    expect(second.reused).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
    expect(second.after.sort()).toEqual([a, b].sort());

    await cdp.evalInPage(collectionOp, { op: "delete", ref: first.id }, "cleanup");
  });

  it("refuses to write to a dynamic collection and leaves it untouched", async () => {
    const cols = await cdp.evalInPage(listCollections, undefined, "find-dynamic");
    const dynamic = cols.find((c) => c.isDynamic && !c.isSystem);
    if (!dynamic) return; // library has none

    const before = await cdp.evalInPage(getCollection, { ref: dynamic.id }, "before");
    await expect(
      cdp.evalInPage(
        collectionOp,
        { op: "add", ref: dynamic.id, appids: [testAppids[0]!] },
        "dynamic-write",
      ),
    ).rejects.toThrow(/DYNAMIC_COLLECTION|NOT_EDITABLE/);

    const after = await cdp.evalInPage(getCollection, { ref: dynamic.id }, "after");
    expect(after.appids).toEqual(before.appids);
  });

  it("does not write anything on a dry run", async () => {
    const name = scratchName("-dry");
    const before = await cdp.evalInPage(listCollections, undefined, "before-dry");
    const result = await cdp.evalInPage(
      collectionOp,
      { op: "create", name, appids: [testAppids[0]!], dryRun: true },
      "dry-create",
    );
    expect(result.added).toEqual([testAppids[0]]);

    const after = await cdp.evalInPage(listCollections, undefined, "after-dry");
    expect(after.length).toBe(before.length);
    expect(after.some((c) => c.name === name)).toBe(false);
  });

  /**
   * Round-trips the flags for real. A dry run can never catch the bug these
   * had, because a preview does not call the Steam API it is previewing.
   */
  it.each(["favorite", "hidden"] as const)("actually toggles the %s flag", async (flag) => {
    const appid = testAppids[0]!;
    const read = async (): Promise<boolean> =>
      cdp.evalInPage(
        (arg: { id: number; flag: string }) => {
          const cs = (globalThis as any).collectionStore;
          if (arg.flag === "hidden") return !!cs.BIsHidden?.(arg.id);
          const c = cs.GetCollection("favorite");
          for (const x of c?.allApps || []) if (x.appid === arg.id) return true;
          return false;
        },
        { id: appid, flag },
        `read-${flag}`,
      );

    const original = await read();
    try {
      const result = await cdp.evalInPage(
        setAppFlags,
        { appids: [appid], flag, value: !original },
        `set-${flag}`,
      );
      expect(result.applied).toEqual([appid]);
      expect(await read()).toBe(!original);
    } finally {
      await cdp.evalInPage(
        setAppFlags,
        { appids: [appid], flag, value: original },
        `restore-${flag}`,
      );
    }
    expect(await read()).toBe(original);
  });

  it("skips an unresolvable appid rather than passing it to Steam", async () => {
    const result = await cdp.evalInPage(
      setAppFlags,
      { appids: [testAppids[0]!, 42424242], flag: "hidden", value: false },
      "bogus",
    );
    expect(result.skipped).toEqual([42424242]);
    expect(result.applied).toEqual([testAppids[0]]);
  });
});
