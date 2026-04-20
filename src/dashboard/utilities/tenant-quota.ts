import type { TenantQuotaMetricUsage, TenantWorkflowCreationRateUsage } from '../api-client.ts';

export type TenantQuotaSeverity = 'normal' | 'warning' | 'danger';

export type TenantQuotaMeter = {
  percentage: number;
  severity: TenantQuotaSeverity;
};

function clampPercentage(value: number): number {
  return Math.min(100, Math.max(0, value));
}

export function computeTenantQuotaMeter(metric: TenantQuotaMetricUsage): TenantQuotaMeter {
  if (metric.limit === null) {
    return {
      percentage: 0,
      severity: 'normal',
    };
  }

  if (metric.limit === 0) {
    return metric.used > 0
      ? {
          percentage: 100,
          severity: 'danger',
        }
      : {
          percentage: 0,
          severity: 'normal',
        };
  }

  if (metric.limit < 0) {
    return {
      percentage: 0,
      severity: 'normal',
    };
  }

  const ratio = metric.used / metric.limit;

  return {
    percentage: clampPercentage(ratio * 100),
    severity: ratio >= 1 ? 'danger' : ratio >= 0.8 ? 'warning' : 'normal',
  };
}

export function formatTenantQuotaBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function formatTenantQuotaWindow(
  workflowCreationRate: TenantWorkflowCreationRateUsage,
): string {
  if (workflowCreationRate.windowMilliseconds === null) {
    return 'No window configured';
  }

  const totalSeconds = Math.floor(workflowCreationRate.windowMilliseconds / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s window`;
  }

  const totalMinutes = totalSeconds / 60;
  if (Number.isInteger(totalMinutes)) {
    return `${totalMinutes}m window`;
  }

  return `${totalMinutes.toFixed(1)}m window`;
}
