/**
 * A faithful fake of the globals Steam exposes in SharedJSContext.
 *
 * "Faithful" is the point: this reproduces Steam's real semantics, including
 * the sharp edges we had to discover the hard way, so a page program that would
 * misbehave against the real client also misbehaves here.
 *
 * Reproduced quirks:
 *  - AddOrRemoveApp takes RAW APPIDS and maps them through GetAppOverviewByAppID
 *    itself, filtering only `undefined` — never `null`. Passing AppOverviews
 *    therefore yields a null that survives the filter and crashes AddApps with
 *    "Cannot read properties of null (reading 'appid')".
 *  - SaveCollection DELETES an existing deletable collection with the same
 *    display name when saving a new one.
 *  - AsDragDropCollection returns null for dynamic and system collections.
 *  - NewUnsavedCollection reads `.appid` off each seed entry (objects, not ids).
 */

export interface FakeAppSpec {
  appid: number;
  name: string;
  kind?: "game" | "software" | "music" | "video" | "tool";
  playtimeMinutes?: number;
  lastPlayed?: number;
  sizeOnDisk?: number;
  installed?: boolean;
  shortcut?: boolean;
  owned?: boolean;
  borrowed?: boolean;
  tags?: number[];
  reviewPercentage?: number;
  metacriticScore?: number;
}

export interface FakeCollectionSpec {
  id: string;
  name: string;
  appids?: number[];
  dynamic?: boolean;
  system?: boolean;
}

const KIND_TO_COLLECTION: Record<string, string> = {
  game: "type-games",
  software: "type-software",
  music: "type-music",
  video: "type-videos",
  tool: "type-tools",
};

class FakeAppOverview {
  appid: number;
  display_name: string;
  sort_as: string;
  app_type: number;
  size_on_disk: number;
  rt_last_time_played: number;
  minutes_playtime_forever: number;
  rt_purchased_time = 0;
  review_percentage: number;
  metacritic_score: number;
  steam_deck_compat_category = 0;
  store_tag: number[];
  visible_in_game_list = true;
  /** Deliberately unreliable, exactly as in the real client. */
  installed = true;

  constructor(
    private readonly spec: FakeAppSpec,
    private readonly store: FakeSteam,
  ) {
    this.appid = spec.appid;
    this.display_name = spec.name;
    this.sort_as = spec.name;
    this.app_type = 1;
    this.size_on_disk = spec.sizeOnDisk ?? 0;
    this.rt_last_time_played = spec.lastPlayed ?? 0;
    this.minutes_playtime_forever = spec.playtimeMinutes ?? 0;
    this.review_percentage = spec.reviewPercentage ?? 0;
    this.metacritic_score = spec.metacriticScore ?? 0;
    this.store_tag = spec.tags ?? [];
  }

  BIsShortcut(): boolean {
    return this.spec.shortcut === true;
  }
  BIsOwned(): boolean {
    return this.spec.owned !== false;
  }
  BIsBorrowed(): boolean {
    return this.spec.borrowed === true;
  }
  BIsVisible(): boolean {
    return true;
  }
  GetStoreTags(): number[] {
    return this.store_tag;
  }
  GetGameID(): string {
    return String(this.appid);
  }
  BIsUnreleased(): boolean {
    return false;
  }
  void_unused(): FakeSteam {
    return this.store;
  }
}

class FakeCollection {
  readonly id: string;
  displayName: string;
  bIsDynamic: boolean;
  readonly bIsSystem: boolean;
  m_setAddedManually: Set<number>;
  m_setRemovedManually = new Set<number>();

  constructor(
    spec: FakeCollectionSpec,
    private readonly store: FakeSteam,
  ) {
    this.id = spec.id;
    this.displayName = spec.name;
    this.bIsDynamic = spec.dynamic === true;
    this.bIsSystem = spec.system === true;
    this.m_setAddedManually = new Set(spec.appids ?? []);
  }

  get allApps(): FakeAppOverview[] {
    const out: FakeAppOverview[] = [];
    for (const appid of this.m_setAddedManually) {
      const ov = this.store.rawOverview(appid);
      if (ov) out.push(ov);
    }
    return out;
  }

  get bIsDeletable(): boolean {
    return !this.bIsSystem && !this.bIsDynamic;
  }

  /** Null for dynamic and system collections, exactly as Steam does. */
  AsDragDropCollection(): FakeDragDrop | null {
    if (this.bIsDynamic || this.bIsSystem) return null;
    return new FakeDragDrop(this);
  }

  /**
   * System collections (favorite/hidden) are still mutable internally - Steam
   * reaches them through AddOrRemoveApp rather than the public drag-drop path.
   */
  AsDragDropCollectionForSystem(): FakeDragDrop {
    return new FakeDragDrop(this);
  }

  AsDeletableCollection(): { Delete: () => Promise<void> } | null {
    if (!this.bIsDeletable) return null;
    return {
      Delete: async () => {
        this.store.deleteCollection(this.id);
      },
    };
  }

  SetName(name: string): void {
    this.displayName = name;
  }

  async Save(): Promise<void> {
    await this.store.collectionStore.SaveCollection(this);
  }
}

class FakeDragDrop {
  constructor(private readonly collection: FakeCollection) {}

  /** Reads `.appid` off each entry — a null here is a TypeError, as in Steam. */
  AddApps(entries: Array<{ appid: number }>): void {
    for (const entry of entries) {
      this.collection.m_setAddedManually.add(entry.appid);
      this.collection.m_setRemovedManually.delete(entry.appid);
    }
  }

  RemoveApps(entries: Array<{ appid: number }>): void {
    for (const entry of entries) {
      this.collection.m_setAddedManually.delete(entry.appid);
    }
  }
}

export class FakeSteam {
  private apps = new Map<number, FakeAppOverview>();
  private collections = new Map<string, FakeCollection>();
  /** Records every SaveCollection call, for assertions about persistence. */
  saveCalls: string[] = [];
  wizardCalls: Array<{ kind: string; appids: number[] }> = [];

  constructor(apps: FakeAppSpec[] = [], collections: FakeCollectionSpec[] = []) {
    for (const spec of apps) this.apps.set(spec.appid, new FakeAppOverview(spec, this));

    const installed = apps.filter((a) => a.installed).map((a) => a.appid);
    const byKind = new Map<string, number[]>();
    for (const app of apps) {
      const cid = KIND_TO_COLLECTION[app.kind ?? "game"] ?? "type-games";
      byKind.set(cid, [...(byKind.get(cid) ?? []), app.appid]);
    }

    const system: FakeCollectionSpec[] = [
      { id: "favorite", name: "Favorites", appids: [], system: true },
      { id: "hidden", name: "Hidden", appids: [], system: true },
      { id: "local-install", name: "Installed", appids: installed, system: true },
      ...[...byKind].map(([id, appids]) => ({ id, name: id, appids, system: true })),
    ];
    for (const spec of [...system, ...collections]) {
      this.collections.set(spec.id, new FakeCollection(spec, this));
    }
  }

  rawOverview(appid: number): FakeAppOverview | undefined {
    return this.apps.get(appid);
  }

  /** Installs the fake as the page globals a program expects. */
  install(target: Record<string, unknown> = globalThis): void {
    target["collectionStore"] = this.collectionStore;
    target["appStore"] = this.appStore;
    target["SteamClient"] = this.SteamClient;
  }

  static uninstall(target: Record<string, unknown> = globalThis): void {
    delete target["collectionStore"];
    delete target["appStore"];
    delete target["SteamClient"];
  }

  deleteCollection(id: string): void {
    this.collections.delete(id);
  }

  collectionIds(): string[] {
    return [...this.collections.keys()];
  }

  membership(id: string): number[] {
    return [...(this.collections.get(id)?.m_setAddedManually ?? [])];
  }

  get appStore() {
    const apps = this.apps;
    return {
      /**
       * Returns null for anything that is not a known numeric appid. Passing an
       * AppOverview object here is what produced the real null-crash.
       */
      GetAppOverviewByAppID(appid: unknown): FakeAppOverview | null {
        if (typeof appid !== "number") return null;
        return apps.get(appid) ?? null;
      },
      GetLocalizationForStoreTag(id: number): string | undefined {
        return TAG_NAMES[id];
      },
      get allApps() {
        return [...apps.values()];
      },
    };
  }

  get collectionStore() {
    const self = this;
    return {
      get userCollections(): FakeCollection[] {
        return [...self.collections.values()].filter((c) => !c.bIsSystem);
      },
      get allAppsCollection() {
        return { allApps: [...self.apps.values()] };
      },
      get appTypeCollectionMap(): Map<string, FakeCollection> {
        const m = new Map<string, FakeCollection>();
        for (const [id, c] of self.collections) if (id.startsWith("type-")) m.set(id, c);
        return m;
      },
      GetCollection(id: string): FakeCollection | undefined {
        return self.collections.get(id);
      },
      GetUserCollectionsByName(name: string): FakeCollection[] {
        return [...self.collections.values()].filter((c) => c.displayName === name && !c.bIsSystem);
      },
      GetCollectionIDByUserTag(name: string): string | undefined {
        if (name === "favorite") return "favorite";
        for (const c of self.collections.values()) {
          if (!c.bIsSystem && c.displayName === name) return c.id;
        }
        return undefined;
      },
      GetCollectionListForAppID(appid: number): FakeCollection[] {
        return [...self.collections.values()].filter((c) => c.m_setAddedManually.has(appid));
      },
      BIsHidden(appid: number): boolean {
        return self.collections.get("hidden")?.m_setAddedManually.has(appid) ?? false;
      },
      BIsSystemCollectionName(name: string): boolean {
        return ["Favorites", "Hidden", "Uncategorized"].includes(name);
      },
      NewUnsavedCollection(
        name: string,
        filter: unknown,
        seed: Array<{ appid: number }>,
      ): FakeCollection {
        // Reads `.appid` off each seed entry: raw numbers produce undefined.
        const appids = (seed ?? []).map((s) => s.appid).filter((a) => typeof a === "number");
        const c = new FakeCollection(
          { id: `uc-new-${self.collections.size}`, name, appids, dynamic: !!filter },
          self,
        );
        return c;
      },
      async SaveCollection(c: FakeCollection): Promise<void> {
        self.saveCalls.push(c.id);
        const isNew = !self.collections.has(c.id);
        if (isNew) {
          if (this.BIsSystemCollectionName(c.displayName)) {
            throw new Error("Collection name collision.");
          }
          // Steam DELETES a same-named deletable collection here.
          for (const existing of this.GetUserCollectionsByName(c.displayName)) {
            if (existing.bIsDeletable) self.collections.delete(existing.id);
          }
        }
        self.collections.set(c.id, c);
      },
      async DeleteCollection(id: string): Promise<void> {
        self.collections.delete(id);
      },
      /** Takes RAW APPIDS; filters only undefined, never null. */
      AddOrRemoveApp(appids: unknown[], add: boolean, collectionId: string): void {
        const dd = self.collections.get(collectionId)?.AsDragDropCollectionForSystem();
        if (!dd) throw new Error("no drag drop collection");
        const overviews = appids
          .map((id) => self.appStore.GetAppOverviewByAppID(id))
          .filter((e) => undefined !== e) as Array<{ appid: number }>;
        if (add) dd.AddApps(overviews);
        else dd.RemoveApps(overviews);
      },
      async SetAppsAsFavorite(appids: unknown[], value: boolean): Promise<void> {
        this.AddOrRemoveApp(appids, value, "favorite");
      },
      async SetAppsAsHidden(appids: unknown[], value: boolean): Promise<void> {
        this.AddOrRemoveApp(appids, value, "hidden");
      },
    };
  }

  get SteamClient() {
    const self = this;
    return {
      Installs: {
        async OpenInstallWizard(appids: number[]): Promise<void> {
          self.wizardCalls.push({ kind: "install", appids });
        },
        async OpenUninstallWizard(appids: number[]): Promise<void> {
          self.wizardCalls.push({ kind: "uninstall", appids });
        },
      },
    };
  }
}

const TAG_NAMES: Record<number, string> = {
  9: "Strategy",
  19: "Action",
  492: "Indie",
  1716: "Roguelike",
};

/** A small library used by most page-program tests. */
export function defaultFakeSteam(): FakeSteam {
  return new FakeSteam(
    [
      {
        appid: 427520,
        name: "Factorio",
        installed: true,
        playtimeMinutes: 9028,
        tags: [9, 492],
        sizeOnDisk: 2_591_773_184,
        lastPlayed: 1784500000,
      },
      {
        appid: 212680,
        name: "FTL: Faster Than Light",
        installed: true,
        playtimeMinutes: 1,
        tags: [1716, 492],
        sizeOnDisk: 527_085_568,
      },
      { appid: 620, name: "Portal 2", playtimeMinutes: 0, tags: [19] },
      { appid: 999, name: "Steamworks Common Redistributables", kind: "tool" },
      { appid: 207080, name: "Indie Game: The Movie", kind: "video", lastPlayed: 1356307200 },
    ],
    [
      { id: "uc-static", name: "Roguelike / Roguelite", appids: [212680] },
      { id: "uc-8qBpJj1*+Borh", name: "City Builder & Management", appids: [427520] },
      { id: "uc-dynamic", name: "Atmospheric", appids: [], dynamic: true },
    ],
  );
}
