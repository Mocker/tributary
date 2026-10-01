export interface LearningEntry {
  title: string;
  category: 'architecture' | 'invariant' | 'dependency' | 'security';
  rule: string;
  insight: string;
  sourceForks: string[];
  crystallizedAt: string;
}

export class EpistemicCrystallizer {
  /**
   * Crystallizes a verified architectural rule into repository memory (.git/learnings/)
   */
  formatLearningNote(entry: LearningEntry): string {
    return `---
title: "${entry.title}"
category: "${entry.category}"
source_forks: [${entry.sourceForks.map((f) => `"${f}"`).join(', ')}]
crystallized_at: "${entry.crystallizedAt}"
---

# ${entry.title}

## ⚡ Concrete Actionable Rule
> ${entry.rule}

## 🔍 Context & Verified Invariant
${entry.insight}
`;
  }
}
