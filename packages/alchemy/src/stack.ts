/**
 * Infrastructure as Effects definition for Operon deployed via Alchemy (alchemy.run)
 */

export interface CloudflareD1Config {
  readonly bindingName: string;
  readonly databaseName: string;
}

export interface CloudflareR2Config {
  readonly bindingName: string;
  readonly bucketName: string;
}

export interface CloudflareQueueConfig {
  readonly bindingName: string;
  readonly queueName: string;
}

export interface OperonInfrastructureConfig {
  readonly environment: "development" | "staging" | "production";
  readonly d1: CloudflareD1Config;
  readonly r2Vault: CloudflareR2Config;
  readonly eventQueue: CloudflareQueueConfig;
  readonly workerName: string;
}

/**
 * Default Cloudflare edge infrastructure configuration for Operon
 */
export const defaultOperonConfig: OperonInfrastructureConfig = {
  d1: {
    bindingName: "DB",
    databaseName: "operon-ontology-store",
  },
  environment: "production",
  eventQueue: {
    bindingName: "EVENT_QUEUE",
    queueName: "operon-cdc-events",
  },
  r2Vault: {
    bindingName: "AUDIT_VAULT",
    bucketName: "operon-decision-records",
  },
  workerName: "operon-decision-runtime",
};

/**
 * Alchemy Stack definition synthesizer for Operon Cloudflare Deployment
 */
export function synthesizeAlchemyManifest(
  config: OperonInfrastructureConfig = defaultOperonConfig
) {
  return {
    name: "operon-stack",
    provider: "cloudflare",
    resources: {
      d1: {
        binding: config.d1.bindingName,
        name: config.d1.databaseName,
        type: "cloudflare:d1_database",
      },
      queue: {
        binding: config.eventQueue.bindingName,
        name: config.eventQueue.queueName,
        type: "cloudflare:queue",
      },
      r2: {
        binding: config.r2Vault.bindingName,
        name: config.r2Vault.bucketName,
        type: "cloudflare:r2_bucket",
      },
      worker: {
        bindings: [
          {
            type: "d1",
            binding: config.d1.bindingName,
            database: config.d1.databaseName,
          },
          {
            type: "r2",
            binding: config.r2Vault.bindingName,
            bucket: config.r2Vault.bucketName,
          },
          {
            type: "queue",
            binding: config.eventQueue.bindingName,
            queue: config.eventQueue.queueName,
          },
        ],
        entrypoint: "./src/worker.ts",
        name: config.workerName,
        type: "cloudflare:worker",
      },
    },
  };
}
