import type { Progress } from "./pipeline.ts";
import { remaining } from "./voice.ts";

/** "analyze": Chat, Sprache und Auswertung; "clips": Clip-Schnitt danach */
export type LivePhase = "analyze" | "clips";

export interface LiveProgressStatus extends Progress {
  phase: LivePhase;
}

/**
 * Fortschritt der automatischen Auswertung nach Stream-Ende, für die
 * Oberfläche. Wo ein Schritt selbst keine Restzeit meldet (Chat-Download,
 * Clips), wird sie aus dem bisherigen Fortschritt hochgerechnet. Die
 * Gesamt-Restzeit enthält auch die noch folgenden Schritte (`later`).
 */
export class LiveProgress {
  private current?: LiveProgressStatus;
  private started = new Map<string, number>();

  constructor(private now: () => number = Date.now) {}

  /** `later`: geschätzte Sekunden für Schritte, die danach noch kommen */
  update(phase: LivePhase, p: Progress, later = 0): void {
    const key = `${phase}:${p.stage}`;
    if (!this.started.has(key)) this.started.set(key, this.now());
    const elapsed = (this.now() - this.started.get(key)!) / 1000;
    const eta = p.eta ?? (p.percent !== undefined ? remaining(p.percent, elapsed) : undefined);
    const own = p.totalEta ?? eta;
    const total = own !== undefined ? own + later : later > 0 ? later : undefined;
    this.current = { ...p, phase, eta, totalEta: total };
  }

  get(): LiveProgressStatus | undefined {
    return this.current;
  }

  reset(): void {
    this.current = undefined;
    this.started.clear();
  }
}
