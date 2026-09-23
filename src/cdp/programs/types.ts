/**
 * Shapes returned by the in-page programs.
 *
 * Everything here crosses the CDP boundary, so every value must be plain JSON.
 * AppOverviews are MobX proxies whose getters throw on some fields and which
 * fail to structured-clone, so the programs project them to primitives *inside*
 * the page rather than shipping the proxies out.
 */

export interface StoreProbe {
  collectionStore: boolean;
  appStore: boolean;
  steamClient: boolean;
  appCount: number;
  collectionCount: number;
}

/**
 * Columnar library snapshot. A 2300-game library as an array of objects is
 * several megabytes of repeated key names; tuples cut that by roughly 3-4x.
 */
export interface LibrarySnapshot {
  cols: string[];
  rows: Array<Array<number | string>>;
  /** Appids actually installed on this machine, per the local-install collection. */
  installed: number[];
  /** Store tag id -> localized name. */
  tagNames: Record<string, string>;
  /** Appid -> store tag ids, only when requested. */
  appTags: Record<string, number[]>;
  total: number;
}

export interface CollectionSummary {
  id: string;
  name: string;
  isDynamic: boolean;
  isEditable: boolean;
  isSystem: boolean;
  appCount: number;
}

export interface CollectionDetail extends CollectionSummary {
  appids: number[];
}

export interface MutationResult {
  id: string;
  name: string;
  before: number[];
  after: number[];
  added: number[];
  removed: number[];
  /** Appids that could not be resolved to an owned app, with the reason. */
  skipped: Array<{ appid: number; reason: string }>;
  created: boolean;
  reused: boolean;
}

export interface WizardResult {
  appid: number;
  name: string;
  wizard: "install" | "uninstall";
  opened: boolean;
  alreadyInstalled: boolean;
}

export interface AppDetail {
  appid: number;
  name: string;
  sortAs: string;
  appType: number;
  installed: boolean;
  hidden: boolean;
  favorite: boolean;
  sizeOnDisk: number;
  playtimeMinutes: number;
  lastPlayed: number;
  purchasedTime: number;
  reviewPercentage: number;
  metacriticScore: number;
  deckCompat: number;
  isShortcut: boolean;
  isOwned: boolean;
  isBorrowed: boolean;
  tags: string[];
  collections: Array<{ id: string; name: string }>;
}
