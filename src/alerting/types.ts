export type AlertAction = 'log' | 'webhook';

export type AlertMetric = 'workflow.failure_rate' | 'activity.p99_duration';

export type AlertRule = {
  metric: AlertMetric;
  threshold: number;
  window?: string; // duration string like '5m', '1m' — parsed by parseDuration
  action: AlertAction;
};

export type WebhookTarget = {
  url: string;
  events: Array<'alert:fired' | 'alert:resolved'>;
};

export type AlertingOptions = {
  rules: AlertRule[];
  webhooks?: WebhookTarget[];
};

export type AlertStatus = 'idle' | 'firing';

export type AlertState = {
  rule: AlertRule;
  status: AlertStatus;
  currentValue: number;
  lastFiredAt?: number;
  lastResolvedAt?: number;
};
