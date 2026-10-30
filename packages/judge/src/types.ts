/** How one revealed entry scored against a task's criteria. */
export interface EntryScore {
  /** A whole number from 0 to 100. */
  score: number;
  /** Whether `score` reaches the criteria's `min_score`. */
  passed: boolean;
  /** Why the entry got its score, one line each. Empty for a perfect score. */
  reasons: string[];
}
