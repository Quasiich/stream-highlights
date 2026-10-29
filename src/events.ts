import type { ChatLog } from "./chat.ts";

/** Ein Sub, Raid oder Cheer, getrennt von den Highlights. */
export interface StreamEvent {
  /** Sekunden seit Stream-Beginn */
  offset: number;
  /** "sub", "resub", "subgift", "submysterygift", "raid", "bits" */
  type: string;
  user: string;
  /** Monate (resub), Anzahl Subs (submysterygift), Zuschauer (raid) oder Bits */
  amount?: number;
}

export interface EventSummary {
  /** Neue Subs, ohne Resubs und verschenkte */
  subs: number;
  giftedSubs: number;
  raids: number;
  bits: number;
}

/** Ab wann ein Event einzeln aufgelistet wird */
export const EVENT_MINIMUMS = {
  /** Subs pro Gift-Bombe */
  giftedSubs: 5,
  /** Zuschauer pro Raid */
  raidViewers: 10,
  /** Bits pro Cheer */
  bits: 500,
};

/** Wie weit die einzelnen Geschenk-Zeilen von "X is gifting 5 Subs" entfernt sein dürfen */
const GIFT_BOMB_SECONDS = 30;

/**
 * Sammelt alle Events des Chats. Die einzelnen "gifted a sub to …"-Zeilen einer
 * Gift-Bombe werden in der Bombe zusammengefasst, sonst stünde eine 50er-Bombe
 * 51-mal in der Liste. Die Zeilen können vor oder nach der Ankündigung stehen.
 * Resubs werden weggelassen.
 */
export function collectEvents(log: ChatLog): StreamEvent[] {
  const bombs = log.messages
    .filter((m) => m.event === "submysterygift")
    .map((m) => ({ user: m.user, offset: m.offset, left: m.amount ?? 0 }));

  const events: StreamEvent[] = [];
  for (const m of log.messages) {
    if (!m.event || m.event === "resub") continue;
    if (m.event === "subgift") {
      const bomb = bombs.find((b) => b.user === m.user && b.left > 0 && Math.abs(m.offset - b.offset) <= GIFT_BOMB_SECONDS);
      if (bomb) {
        bomb.left--;
        continue;
      }
    }
    events.push({ offset: m.offset, type: m.event, user: m.user, amount: m.amount });
  }
  return events;
}

export function summarize(events: StreamEvent[]): EventSummary {
  const sum: EventSummary = { subs: 0, giftedSubs: 0, raids: 0, bits: 0 };
  for (const e of events) {
    if (e.type === "sub") sum.subs++;
    else if (e.type === "subgift") sum.giftedSubs++;
    else if (e.type === "submysterygift") sum.giftedSubs += e.amount ?? 1;
    else if (e.type === "raid") sum.raids++;
    else if (e.type === "bits") sum.bits += e.amount ?? 0;
  }
  return sum;
}

/**
 * Gift-Bomben, Raids und Cheers ab EVENT_MINIMUMS. Einzelne Subs und
 * Geschenk-Subs stehen nur in der Summe.
 */
export function isNotable(e: StreamEvent): boolean {
  switch (e.type) {
    case "submysterygift":
      return (e.amount ?? 0) >= EVENT_MINIMUMS.giftedSubs;
    case "raid":
      // Ohne Zuschauerzahl (älteres Format) lieber anzeigen als verschlucken
      return e.amount === undefined || e.amount >= EVENT_MINIMUMS.raidViewers;
    case "bits":
      return (e.amount ?? 0) >= EVENT_MINIMUMS.bits;
    default:
      return false;
  }
}

export function describe(e: StreamEvent): string {
  switch (e.type) {
    case "sub":
      return "Sub";
    case "resub":
      return e.amount ? `Resub (${e.amount} Monate)` : "Resub";
    case "subgift":
      return "1 Sub verschenkt";
    case "submysterygift":
      return e.amount === 1 ? "1 Sub verschenkt" : `${e.amount ?? "?"} Subs verschenkt`;
    case "raid":
      return e.amount ? `Raid mit ${e.amount} Zuschauern` : "Raid";
    case "bits":
      return `${e.amount ?? "?"} Bits`;
    default:
      return e.type;
  }
}
