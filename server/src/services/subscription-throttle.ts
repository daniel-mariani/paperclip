import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { costEvents, subscriptionThrottleState } from "@paperclipai/db";
import type { MonthlySpendThrottleConfig, SubscriptionThrottleConfig } from "@paperclipai/shared";
import { subscriptionWindowUsage } from "./costs.js";

/** Minimal interface used by subscriptionThrottleService. Uses unknown return to avoid Zod v4 + TS7 inference issues with the full InstanceGeneralSettings shape. */
interface InstanceSettingsWithThrottle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getGeneral(): Promise<any>;
}

export type SubscriptionThrottleBlock = {
  active: true;
  provider: string;
  usagePercent: number;
  since: Date;
  reason: string;
};

export type SubscriptionThrottleStatus = {
  configured: boolean;
  enabled: boolean;
  active: boolean;
  usagePercent: number;
  since: Date | null;
  provider: string;
  estimatedCeilingTokens: number;
  pausePercent: number;
  resumePercent: number;
};

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

export type MonthlySpendThrottleStatus = {
  configured: boolean;
  enabled: boolean;
  active: boolean;
  usagePercent: number;
  spendCents: number;
  monthlyBudgetCents: number;
  since: Date | null;
  provider: string;
  pausePercent: number;
  resumePercent: number;
};

export function subscriptionThrottleService(
  db: Db,
  instanceSvc: InstanceSettingsWithThrottle,
) {
  async function readState(companyId: string, provider: string) {
    return db
      .select()
      .from(subscriptionThrottleState)
      .where(
        and(
          eq(subscriptionThrottleState.companyId, companyId),
          eq(subscriptionThrottleState.provider, provider),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function writeState(
    companyId: string,
    provider: string,
    throttleActive: boolean,
    usagePercent: number,
  ) {
    const now = new Date();
    const usagePercentStr = usagePercent.toFixed(4);
    await db
      .insert(subscriptionThrottleState)
      .values({
        companyId,
        provider,
        throttleActive,
        usagePercent: usagePercentStr,
        since: throttleActive ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [subscriptionThrottleState.companyId, subscriptionThrottleState.provider],
        set: {
          throttleActive,
          usagePercent: usagePercentStr,
          since: throttleActive ? now : null,
          updatedAt: now,
        },
      });
  }

  return {
    getBlock: async (companyId: string): Promise<SubscriptionThrottleBlock | null> => {
      const general = await instanceSvc.getGeneral();
      const config = general.subscriptionThrottle as SubscriptionThrottleConfig | undefined;
      if (!config?.enabled) return null;

      const { usage, windowStart: _ } = await subscriptionWindowUsage(db, companyId, {
        provider: config.provider,
        billingTypes: config.billingTypes,
        windowHours: config.windowHours,
        cachedWeight: config.cachedWeight,
      });

      const usagePercent = (usage / config.estimatedCeilingTokens) * 100;
      const currentState = await readState(companyId, config.provider);
      const wasActive = currentState?.throttleActive ?? false;

      const shouldActivate = !wasActive && usagePercent >= config.pausePercent;
      const shouldDeactivate = wasActive && usagePercent < config.resumePercent;

      let throttleActive = wasActive;
      if (shouldActivate) throttleActive = true;
      if (shouldDeactivate) throttleActive = false;

      if (shouldActivate || shouldDeactivate || !currentState) {
        await writeState(companyId, config.provider, throttleActive, usagePercent);
      }

      if (!throttleActive) return null;

      const since = currentState?.since && !shouldActivate
        ? currentState.since
        : new Date();

      return {
        active: true,
        provider: config.provider,
        usagePercent,
        since,
        reason: `Subscription window throttle active: ${usagePercent.toFixed(1)}% of estimated ${config.estimatedCeilingTokens.toLocaleString()} token ceiling used in the last ${config.windowHours}h. Dispatch will resume when usage drops below ${config.resumePercent}%.`,
      };
    },

    getStatus: async (companyId: string): Promise<SubscriptionThrottleStatus> => {
      const general = await instanceSvc.getGeneral();
      const config = general.subscriptionThrottle as SubscriptionThrottleConfig | undefined;
      if (!config?.enabled) {
        return {
          configured: Boolean(config),
          enabled: false,
          active: false,
          usagePercent: 0,
          since: null,
          provider: config?.provider ?? "anthropic",
          estimatedCeilingTokens: config?.estimatedCeilingTokens ?? 1_500_000,
          pausePercent: config?.pausePercent ?? 80,
          resumePercent: config?.resumePercent ?? 50,
        };
      }

      const state = await readState(companyId, config.provider);
      const { usage } = await subscriptionWindowUsage(db, companyId, {
        provider: config.provider,
        billingTypes: config.billingTypes,
        windowHours: config.windowHours,
        cachedWeight: config.cachedWeight,
      });
      const usagePercent = (usage / config.estimatedCeilingTokens) * 100;

      return {
        configured: true,
        enabled: true,
        active: state?.throttleActive ?? false,
        usagePercent,
        since: state?.since ?? null,
        provider: config.provider,
        estimatedCeilingTokens: config.estimatedCeilingTokens,
        pausePercent: config.pausePercent,
        resumePercent: config.resumePercent,
      };
    },
  };
}

export function monthlySpendThrottleService(
  db: Db,
  instanceSvc: InstanceSettingsWithThrottle,
) {
  async function readState(companyId: string, provider: string) {
    return db
      .select()
      .from(subscriptionThrottleState)
      .where(
        and(
          eq(subscriptionThrottleState.companyId, companyId),
          eq(subscriptionThrottleState.provider, provider),
        ),
      )
      .then((rows) => rows[0] ?? null);
  }

  async function writeState(
    companyId: string,
    provider: string,
    throttleActive: boolean,
    usagePercent: number,
  ) {
    const now = new Date();
    const usagePercentStr = usagePercent.toFixed(4);
    await db
      .insert(subscriptionThrottleState)
      .values({
        companyId,
        provider,
        throttleActive,
        usagePercent: usagePercentStr,
        since: throttleActive ? now : null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [subscriptionThrottleState.companyId, subscriptionThrottleState.provider],
        set: {
          throttleActive,
          usagePercent: usagePercentStr,
          since: throttleActive ? now : null,
          updatedAt: now,
        },
      });
  }

  async function getMonthlySpendCents(companyId: string, provider: string): Promise<number> {
    const { start, end } = currentUtcMonthWindow();
    const [row] = await db
      .select({ total: sql<number>`coalesce(sum(${costEvents.costCents}), 0)::double precision` })
      .from(costEvents)
      .where(
        and(
          eq(costEvents.companyId, companyId),
          eq(costEvents.provider, provider),
          gte(costEvents.occurredAt, start),
          lt(costEvents.occurredAt, end),
        ),
      );
    return Number(row?.total ?? 0);
  }

  return {
    getBlock: async (companyId: string): Promise<SubscriptionThrottleBlock | null> => {
      const general = await instanceSvc.getGeneral();
      const config = general.monthlySpendThrottle as MonthlySpendThrottleConfig | undefined;
      if (!config?.enabled) return null;

      const spendCents = await getMonthlySpendCents(companyId, config.provider);
      const usagePercent = (spendCents / config.monthlyBudgetCents) * 100;
      const currentState = await readState(companyId, config.provider);
      const wasActive = currentState?.throttleActive ?? false;

      const shouldActivate = !wasActive && usagePercent >= config.pausePercent;
      const shouldDeactivate = wasActive && usagePercent < config.resumePercent;

      let throttleActive = wasActive;
      if (shouldActivate) throttleActive = true;
      if (shouldDeactivate) throttleActive = false;

      if (shouldActivate || shouldDeactivate || !currentState) {
        await writeState(companyId, config.provider, throttleActive, usagePercent);
      }

      if (!throttleActive) return null;

      const since = currentState?.since && !shouldActivate
        ? currentState.since
        : new Date();

      const budgetUsd = (config.monthlyBudgetCents / 100).toFixed(2);
      const spendUsd = (spendCents / 100).toFixed(2);
      return {
        active: true,
        provider: config.provider,
        usagePercent,
        since,
        reason: `Monthly spend throttle active: $${spendUsd} of $${budgetUsd} monthly budget used (${usagePercent.toFixed(1)}%). Dispatch will resume once spend drops below ${config.resumePercent}% (typically at calendar month rollover).`,
      };
    },

    getStatus: async (companyId: string): Promise<MonthlySpendThrottleStatus> => {
      const general = await instanceSvc.getGeneral();
      const config = general.monthlySpendThrottle as MonthlySpendThrottleConfig | undefined;
      if (!config?.enabled) {
        return {
          configured: Boolean(config),
          enabled: false,
          active: false,
          usagePercent: 0,
          spendCents: 0,
          monthlyBudgetCents: config?.monthlyBudgetCents ?? 0,
          since: null,
          provider: config?.provider ?? "anthropic",
          pausePercent: config?.pausePercent ?? 80,
          resumePercent: config?.resumePercent ?? 50,
        };
      }

      const [state, spendCents] = await Promise.all([
        readState(companyId, config.provider),
        getMonthlySpendCents(companyId, config.provider),
      ]);
      const usagePercent = (spendCents / config.monthlyBudgetCents) * 100;

      const wasActive = state?.throttleActive ?? false;
      const isActive = wasActive && usagePercent >= config.resumePercent;
      if (wasActive && !isActive) {
        await writeState(companyId, config.provider, false, usagePercent);
      }

      return {
        configured: true,
        enabled: true,
        active: isActive,
        usagePercent,
        spendCents,
        monthlyBudgetCents: config.monthlyBudgetCents,
        since: isActive ? (state?.since ?? null) : null,
        provider: config.provider,
        pausePercent: config.pausePercent,
        resumePercent: config.resumePercent,
      };
    },
  };
}
