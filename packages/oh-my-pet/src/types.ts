export interface BinlogEntry {
  sessionId: string;
  seq: number;
  responseId: string;
  timestamp: number;
  mod: string;
  attributes: Record<string, number>;
}

export interface AttrPolicy {
  min: number;
  max: number;
}

export type AttrPolicies = Record<string, AttrPolicy>;

export interface FeedingMemo {
  lastVitality: number;
}
