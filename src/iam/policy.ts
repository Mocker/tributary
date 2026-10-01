import { parse } from 'yaml';
import { z } from 'zod';

export const AgentRoleSchema = z.object({
  description: z.string().optional(),
  allowed_paths: z.array(z.string()).default(['**']),
  forbidden_paths: z.array(z.string()).default([]),
  max_changed_files_per_turn: z.number().optional().default(20),
  read_only: z.boolean().optional().default(false),
  token_ttl_seconds: z.number().optional().default(3600),
  required_tests: z.array(z.string()).optional().default([]),
});

export const PolicySchema = z.object({
  version: z.string(),
  platform: z.string(),
  invariants: z.object({
    epistemic_air_gap: z.object({
      block_patterns: z.array(z.string()).default([]),
      redact_commit_messages: z.boolean().default(true),
    }).optional(),
    verification: z.object({
      require_t3rl: z.boolean().default(true),
      min_test_pass_rate: z.number().default(1.0),
      max_remediation_turns: z.number().default(3),
    }).optional(),
  }).optional(),
  roles: z.record(z.string(), AgentRoleSchema),
});

export type AgentRole = z.infer<typeof AgentRoleSchema>;
export type Policy = z.infer<typeof PolicySchema>;

export class PolicyEngine {
  private policy: Policy;

  constructor(yamlText: string) {
    const raw = parse(yamlText);
    this.policy = PolicySchema.parse(raw);
  }

  getRole(roleName: string): AgentRole | undefined {
    return this.policy.roles[roleName];
  }

  /**
   * Matches simple glob patterns (e.g., 'src/ui/**', 'wrangler.*')
   */
  private matchGlob(pattern: string, path: string): boolean {
    if (pattern === '**') return true;
    const regexStr = '^' + pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '.') + '$';
    return new RegExp(regexStr).test(path);
  }

  /**
   * Checks if a given path is permitted for an agent role
   */
  isPathPermitted(roleName: string, path: string): { allowed: boolean; reason?: string } {
    const role = this.getRole(roleName);
    if (!role) {
      return { allowed: false, reason: `Unknown role: ${roleName}` };
    }

    if (role.read_only) {
      return { allowed: false, reason: `Role ${roleName} is read-only` };
    }

    // Check explicit forbidden paths first
    for (const forbidden of role.forbidden_paths) {
      if (this.matchGlob(forbidden, path)) {
        return {
          allowed: false,
          reason: `Path '${path}' matches forbidden pattern '${forbidden}' for role '${roleName}'`
        };
      }
    }

    // Check allowed paths
    for (const allowed of role.allowed_paths) {
      if (this.matchGlob(allowed, path)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Path '${path}' not covered by allowed patterns for role '${roleName}'`
    };
  }

  /**
   * Scans text for secrets or credentials violating the Epistemic Air Gap
   */
  scanSecrets(content: string): { safe: boolean; detectedPattern?: string } {
    const patterns = this.policy.invariants?.epistemic_air_gap?.block_patterns || [];
    for (const pat of patterns) {
      const reg = new RegExp(pat, 'm');
      if (reg.test(content)) {
        return { safe: false, detectedPattern: pat };
      }
    }
    return { safe: true };
  }
}
