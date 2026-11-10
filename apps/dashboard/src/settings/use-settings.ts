import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseMutationResult,
  type UseQueryResult,
} from "@tanstack/react-query";
import { useClient } from "../app/context";
import { keys } from "../app/queries";

export interface RateLimitRule {
  label: string;
  audience: string;
  duration: number;
  maxRequests: number;
}

export interface S3Config {
  enabled: boolean;
  bucket: string;
  region: string;
  endpoint: string;
  accessKey: string;
  forcePathStyle: boolean;
}

export interface SettingsModel {
  superuserIPs: string[];
  smtp: {
    enabled: boolean;
    port: number;
    host: string;
    username: string;
    authMethod: string;
    tls: boolean;
    localName: string;
  };
  backups: { cron: string; cronMaxKeep: number; s3: S3Config };
  s3: S3Config;
  meta: {
    accentColor: string;
    appName: string;
    appURL: string;
    senderName: string;
    senderAddress: string;
    hideControls: boolean;
  };
  rateLimits: {
    rules: RateLimitRule[];
    excludedIPs: string[];
    enabled: boolean;
  };
  trustedProxy: { headers: string[]; useLeftmostIP: boolean };
  batch: {
    enabled: boolean;
    maxRequests: number;
    timeout: number;
    maxBodySize: number;
  };
  logs: {
    maxDataSize: number;
    maxDays: number;
    minLevel: number;
    logIP: boolean;
    logAuthId: boolean;
  };
}

export function useSettings(): UseQueryResult<SettingsModel> {
  const client = useClient();
  return useQuery({
    queryKey: keys.settings,
    queryFn: async ({ signal }) =>
      (await client.settings.get({ signal })) as unknown as SettingsModel,
  });
}

export function useHideControls(): boolean {
  const settings = useSettings();
  return settings.data ? settings.data.meta.hideControls : true;
}

export function useSaveSettings(): UseMutationResult<
  SettingsModel,
  unknown,
  Partial<SettingsModel>
> {
  const client = useClient();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data) =>
      (await client.settings.update(data)) as unknown as SettingsModel,
    onSuccess: (saved) => queryClient.setQueryData(keys.settings, saved),
  });
}

export function changedSections<T extends object>(
  before: T,
  after: T,
): Partial<T> {
  const changed: Partial<T> = {};
  for (const key of Object.keys(after) as (keyof T)[]) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key]))
      changed[key] = after[key];
  }
  return changed;
}
