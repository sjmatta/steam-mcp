import type { MutationResult, WizardResult } from "./types.js";

/*
 * IN-PAGE PROGRAMS — write side. Same self-containment rules as read.ts.
 *
 * Every mutation is a single evaluation that resolves, validates, mutates and
 * then RE-READS the collection, so the caller learns what actually happened
 * rather than what was intended. Without Save(), a collection looks entirely
 * correct in Steam's UI and is gone on the next restart.
 */

export interface CollectionOpArg {
  op: "create" | "add" | "remove" | "replace" | "rename" | "delete";
  /** Collection id or exact name. Not used by `create`. */
  ref?: string;
  /** New collection name (`create`) or replacement name (`rename`). */
  name?: string;
  appids?: number[];
  onExisting?: "reuse" | "fail";
  dryRun?: boolean;
}

export const collectionOp = async (arg: CollectionOpArg): Promise<MutationResult> => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  const as = w.appStore;
  if (!cs || !as) throw new Error("STORES_NOT_READY");

  const dryRun = !!arg.dryRun;
  const wanted: number[] = arg.appids || [];

  const systemIds = [
    "favorite",
    "hidden",
    "uncategorized",
    "local-install",
    "my-games",
    "play-next",
  ];
  const isSystemId = (id: string): boolean => systemIds.includes(id) || id.startsWith("type-");

  const membership = (c: any): number[] => {
    const out: number[] = [];
    for (const app of c.allApps || []) out.push(app.appid);
    return out;
  };

  // NewUnsavedCollection and AddApps/RemoveApps read `.appid` off each entry:
  // they take AppOverview objects, not raw numbers. Passing numbers silently
  // produces an empty collection.
  const resolveApps = (
    ids: number[],
  ): { overviews: any[]; skipped: Array<{ appid: number; reason: string }> } => {
    const overviews: any[] = [];
    const skipped: Array<{ appid: number; reason: string }> = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (seen.has(id)) continue;
      seen.add(id);
      let ov: any = null;
      try {
        ov = as.GetAppOverviewByAppID(id);
      } catch {
        // Unknown appid; reported as skipped below.
      }
      if (ov) overviews.push(ov);
      else skipped.push({ appid: id, reason: "not in library (unowned or unknown appid)" });
    }
    return { overviews, skipped };
  };

  const findByRef = (ref: string): any => {
    let c: any = null;
    try {
      c = cs.GetCollection(ref);
    } catch {
      // An unknown id throws here; fall through to the by-name lookup.
    }
    if (c) return c;
    const byName = cs.GetUserCollectionsByName ? cs.GetUserCollectionsByName(ref) : [];
    if (byName?.length === 1) return byName[0];
    if (byName?.length > 1) throw new Error("NAME_COLLISION");
    return null;
  };

  const assertWritable = (c: any): any => {
    if (!!c.bIsDynamic || !!c.m_filterSpec || !!c.internalAppFilter) {
      throw new Error("DYNAMIC_COLLECTION");
    }
    let dd: any = null;
    try {
      dd = c.AsDragDropCollection ? c.AsDragDropCollection() : null;
    } catch {
      // Not a drag-drop collection; the caller refuses the write.
    }
    if (!dd) throw new Error("NOT_EDITABLE");
    return dd;
  };

  const finish = (
    c: any,
    before: number[],
    skipped: Array<{ appid: number; reason: string }>,
    created: boolean,
    reused: boolean,
    // What membership *would* become. Required for dry runs: without it a
    // preview reports no change at all, which is useless for confirming intent.
    projected?: number[],
  ): MutationResult => {
    // Re-read through the store rather than trusting the local handle.
    let fresh: any = c;
    try {
      const again = cs.GetCollection(c.id);
      if (again) fresh = again;
    } catch (e) {
      fresh = c;
    }
    const after = dryRun ? (projected || before).slice() : membership(fresh);
    const beforeSet = new Set(before);
    const afterSet = new Set(after);
    const added: number[] = [];
    const removed: number[] = [];
    for (const id of after) if (!beforeSet.has(id)) added.push(id);
    for (const id of before) if (!afterSet.has(id)) removed.push(id);
    return {
      id: fresh.id,
      name: fresh.displayName || fresh.id,
      before,
      after,
      added,
      removed,
      skipped,
      created,
      reused,
    };
  };

  if (arg.op === "create") {
    const name = arg.name || "";
    if (!name) throw new Error("INVALID_NAME");

    // Steam's SaveCollection DELETES an existing deletable collection whose
    // display name matches a new one. So we never blind-create: resolve first
    // and reuse, which turns a destructive operation into an additive one.
    let existing: any = null;
    try {
      const id = cs.GetCollectionIDByUserTag ? cs.GetCollectionIDByUserTag(name) : null;
      if (typeof id === "string") existing = cs.GetCollection(id);
    } catch (e) {
      existing = null;
    }
    if (!existing) {
      const byName = cs.GetUserCollectionsByName ? cs.GetUserCollectionsByName(name) : [];
      if (byName?.length === 1) existing = byName[0];
      else if (byName?.length > 1) throw new Error("NAME_COLLISION");
    }

    if (existing) {
      if (arg.onExisting === "fail") throw new Error("NAME_COLLISION");
      const before = membership(existing);
      const dd = assertWritable(existing);
      const resolved = resolveApps(wanted);
      if (!dryRun && resolved.overviews.length > 0) {
        dd.AddApps(resolved.overviews); // implicitly calls Save()
        if (typeof existing.Save === "function") await existing.Save();
      }
      const union = before.slice();
      for (const ov of resolved.overviews) if (!union.includes(ov.appid)) union.push(ov.appid);
      return finish(existing, before, resolved.skipped, false, true, union);
    }

    if (cs.BIsSystemCollectionName?.(name)) {
      throw new Error("NAME_COLLISION");
    }

    const resolved = resolveApps(wanted);
    if (dryRun) {
      return {
        id: "(unsaved)",
        name,
        before: [],
        after: resolved.overviews.map((o: any) => o.appid),
        added: resolved.overviews.map((o: any) => o.appid),
        removed: [],
        skipped: resolved.skipped,
        created: true,
        reused: false,
      };
    }

    // Second argument undefined => static collection. Passing a filter here
    // would create a dynamic one, whose membership Steam recomputes and whose
    // manual edits are silently reverted.
    const created = cs.NewUnsavedCollection(name, undefined, resolved.overviews);
    await cs.SaveCollection(created);
    return finish(created, [], resolved.skipped, true, false);
  }

  const ref = arg.ref || "";
  if (!ref) throw new Error("COLLECTION_NOT_FOUND");
  const target = findByRef(ref);
  if (!target) throw new Error("COLLECTION_NOT_FOUND");

  if (arg.op === "delete") {
    if (isSystemId(target.id)) throw new Error("NOT_EDITABLE");
    const before = membership(target);
    // A dry-run delete projects an empty collection, so the caller sees exactly
    // which appids would lose their membership.
    if (dryRun) return finish(target, before, [], false, false, []);

    let deleted = false;
    try {
      if (target.AsDeletableCollection) {
        const del = target.AsDeletableCollection();
        if (del && typeof del.Delete === "function") {
          await del.Delete();
          deleted = true;
        }
      }
    } catch (e) {
      deleted = false;
    }
    if (!deleted) {
      if (typeof cs.DeleteCollection !== "function") throw new Error("UNSUPPORTED");
      await cs.DeleteCollection(target.id);
    }

    let stillThere = false;
    try {
      stillThere = !!cs.GetCollection(target.id);
    } catch {
      // Throwing on lookup is itself proof the collection is gone.
    }
    return {
      id: target.id,
      name: target.displayName || target.id,
      before,
      after: stillThere ? membership(cs.GetCollection(target.id)) : [],
      added: [],
      removed: stillThere ? [] : before,
      skipped: [],
      created: false,
      reused: false,
    };
  }

  if (arg.op === "rename") {
    const newName = arg.name || "";
    if (!newName) throw new Error("INVALID_NAME");
    if (isSystemId(target.id)) throw new Error("NOT_EDITABLE");
    const before = membership(target);
    if (dryRun) return finish(target, before, [], false, false);

    // Renaming keeps the collection id, which matters because the library
    // shelf layout (showcases.*) references ids. Delete-and-recreate would
    // orphan those, so we refuse rather than silently doing it.
    let renamed = false;
    if (typeof target.SetName === "function") {
      target.SetName(newName);
      renamed = true;
    } else if (typeof target.m_strName === "string") {
      target.m_strName = newName;
      renamed = true;
    } else if (typeof target.displayName === "string") {
      try {
        target.displayName = newName;
        renamed = target.displayName === newName;
      } catch (e) {
        renamed = false;
      }
    }
    if (!renamed) throw new Error("UNSUPPORTED");

    if (typeof target.Save === "function") await target.Save();
    else await cs.SaveCollection(target);

    return finish(target, before, [], false, false);
  }

  // add / remove / replace
  const before = membership(target);
  const dd = assertWritable(target);

  if (arg.op === "add") {
    const resolved = resolveApps(wanted);
    if (!dryRun && resolved.overviews.length > 0) {
      dd.AddApps(resolved.overviews);
      if (typeof target.Save === "function") await target.Save();
    }
    const union = before.slice();
    for (const ov of resolved.overviews) if (!union.includes(ov.appid)) union.push(ov.appid);
    return finish(target, before, resolved.skipped, false, false, union);
  }

  if (arg.op === "remove") {
    // Removal only needs overviews for apps actually present; unresolvable
    // appids are reported rather than dropped silently.
    const resolved = resolveApps(wanted);
    if (!dryRun && resolved.overviews.length > 0) {
      dd.RemoveApps(resolved.overviews);
      if (typeof target.Save === "function") await target.Save();
    }
    const dropped: Record<string, boolean> = {};
    for (const ov of resolved.overviews) dropped[String(ov.appid)] = true;
    const remaining = before.filter((id) => !dropped[String(id)]);
    return finish(target, before, resolved.skipped, false, false, remaining);
  }

  // replace
  const desired = resolveApps(wanted);
  const desiredIds = new Set(desired.overviews.map((o: any) => o.appid));
  const toRemove: any[] = [];
  for (const app of target.allApps || []) {
    if (!desiredIds.has(app.appid)) toRemove.push(app);
  }
  if (!dryRun) {
    if (toRemove.length > 0) dd.RemoveApps(toRemove);
    if (desired.overviews.length > 0) dd.AddApps(desired.overviews);
    if (typeof target.Save === "function") await target.Save();
  }
  return finish(
    target,
    before,
    desired.skipped,
    false,
    false,
    desired.overviews.map((o: any) => o.appid),
  );
};

/** Favorites and Hidden are system collections with dedicated helpers. */
export const setAppFlags = async (arg: {
  appids: number[];
  flag: "favorite" | "hidden";
  value: boolean;
  dryRun?: boolean;
}): Promise<{
  flag: string;
  value: boolean;
  applied: number[];
  skipped: number[];
  after: number[];
}> => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  const as = w.appStore;
  if (!cs || !as) throw new Error("STORES_NOT_READY");

  // SetAppsAsFavorite/SetAppsAsHidden take RAW APPIDS, not AppOverviews. They
  // funnel into Steam's AddOrRemoveApp, which does the lookup itself:
  //
  //   AddOrRemoveApp(ids, add, collectionId) {
  //     const dd = this.GetCollection(collectionId).AsDragDropCollection();
  //     const n = ids.map(id => GetAppOverviewByAppID(id)).filter(e => void 0 !== e);
  //     add ? dd.AddApps(n) : dd.RemoveApps(n)
  //   }
  //
  // Passing overviews makes that lookup return null or undefined. Undefined is
  // filtered and the call silently does nothing; null survives the filter (it
  // tests only for undefined) and crashes AddApps with "Cannot read properties
  // of null (reading 'appid')".
  //
  // We still resolve each appid first, but only to validate and report - what we
  // hand Steam is the number. That also protects against Steam's incomplete
  // filter, since an unresolvable id never reaches it.
  const applied: number[] = [];
  const skipped: number[] = [];
  for (const id of arg.appids) {
    let ov: any = null;
    try {
      ov = as.GetAppOverviewByAppID(id);
    } catch {
      // Unknown appid; reported as skipped below.
    }
    if (ov) applied.push(id);
    else skipped.push(id);
  }

  if (!arg.dryRun && applied.length > 0) {
    if (arg.flag === "favorite") {
      if (typeof cs.SetAppsAsFavorite !== "function") throw new Error("UNSUPPORTED");
      await cs.SetAppsAsFavorite(applied, arg.value);
    } else {
      if (typeof cs.SetAppsAsHidden !== "function") throw new Error("UNSUPPORTED");
      await cs.SetAppsAsHidden(applied, arg.value);
    }
  }

  const after: number[] = [];
  try {
    const c = cs.GetCollection(arg.flag);
    for (const app of c?.allApps || []) after.push(app.appid);
  } catch (e) {
    // collection may not exist yet
  }

  return {
    flag: arg.flag,
    value: arg.value,
    applied,
    skipped,
    after,
  };
};

/**
 * Opens Steam's install/uninstall wizard.
 *
 * There is no silent install API in the Steam client — SteamClient.Installs
 * only exposes wizard entry points. Nothing is downloaded or deleted until the
 * user clicks through the dialog that appears.
 */
export const openWizard = async (arg: {
  appid: number;
  kind: "install" | "uninstall";
}): Promise<WizardResult> => {
  const w = globalThis as any;
  const cs = w.collectionStore;
  const as = w.appStore;
  const sc = w.SteamClient;
  if (!cs || !as || !sc?.Installs) throw new Error("STORES_NOT_READY");

  const app = as.GetAppOverviewByAppID(arg.appid);
  if (!app) throw new Error("APP_NOT_FOUND");

  let installed = false;
  try {
    const local = cs.GetCollection("local-install");
    for (const a of local?.allApps || []) {
      if (a.appid === arg.appid) {
        installed = true;
        break;
      }
    }
  } catch (e) {
    installed = false;
  }

  const name = app.display_name || String(arg.appid);

  if (arg.kind === "install") {
    if (installed) {
      return { appid: arg.appid, name, wizard: "install", opened: false, alreadyInstalled: true };
    }
    if (typeof sc.Installs.OpenInstallWizard !== "function") throw new Error("UNSUPPORTED");
    await sc.Installs.OpenInstallWizard([arg.appid]);
    return { appid: arg.appid, name, wizard: "install", opened: true, alreadyInstalled: false };
  }

  if (!installed) {
    return { appid: arg.appid, name, wizard: "uninstall", opened: false, alreadyInstalled: false };
  }
  if (typeof sc.Installs.OpenUninstallWizard !== "function") throw new Error("UNSUPPORTED");
  await sc.Installs.OpenUninstallWizard([arg.appid], true);
  return { appid: arg.appid, name, wizard: "uninstall", opened: true, alreadyInstalled: true };
};
