import type { CollectionModel } from "@heybe/client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { PowerOff, Settings as GearIcon } from "lucide-react";
import { useState } from "react";
import {
  Badge,
  Button,
  EmptyState,
  Select,
  Switch,
  useConfirm,
  useToast,
} from "@heybe/ui";
import { useClient } from "../app/context";
import { ErrorScope, UnclaimedErrors } from "../app/errors";
import { keys, useCollections } from "../app/queries";
import type { Provider } from "../collections/editor-state";
import { ProviderDialog } from "../collections/auth/ProviderDialog";
import {
  OAUTH2_PROVIDERS,
  type ProviderInfo,
} from "../collections/oauth2-providers";
import { ProviderLogo } from "./ProviderLogo";
import { QueryStatus } from "./QueryStatus";
import { SettingsPage } from "./SettingsPage";

type OAuth2 = { enabled: boolean; providers: Provider[] };

export function AuthProvidersPage() {
  const collections = useCollections();
  const auth = collections.data?.filter(
    (c) => c.type === "auth" && c.name !== "_superusers",
  );
  return (
    <SettingsPage title="Auth providers">
      {!auth ? (
        <QueryStatus query={collections} />
      ) : auth.length === 0 ? (
        <EmptyState title="No auth collections">
          Create an auth collection to configure its OAuth2 providers.
        </EmptyState>
      ) : (
        <Providers collections={auth} />
      )}
    </SettingsPage>
  );
}

function Providers({ collections }: { collections: CollectionModel[] }) {
  const client = useClient();
  const queryClient = useQueryClient();
  const confirm = useConfirm();
  const toast = useToast();
  const [selected, setSelected] = useState(
    (collections.find((c) => c.name === "users") ?? collections[0]!).name,
  );
  const [editing, setEditing] = useState<{
    index: number;
    provider: Provider;
  } | null>(null);
  const collection =
    collections.find((c) => c.name === selected) ?? collections[0]!;
  const oauth2 = collection.oauth2 as unknown as OAuth2;
  const providers = oauth2.providers;

  const save = useMutation({
    mutationFn: (patch: Partial<OAuth2>) =>
      client.collections.update(collection.id, {
        oauth2: { ...oauth2, ...patch },
      } as Partial<CollectionModel>),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: keys.collections });
      setEditing(null);
      toast.success("Auth providers saved.");
    },
  });

  const infoFor = (name: string) =>
    OAUTH2_PROVIDERS.find((p) => p.name === name);
  const labelOf = (p: Provider) =>
    String(p.displayName || "") || infoFor(p.name)?.displayName || p.name;
  const enabled = providers.map((provider, index) => ({ provider, index }));
  const others = OAUTH2_PROVIDERS.filter(
    (p) => !providers.some((x) => x.name === p.name),
  );

  const disable = async (index: number, name: string) => {
    const ok = await confirm({
      title: `Disable ${name}?`,
      message: `Users will no longer be able to sign in with ${name}.`,
      confirmLabel: "Disable",
      danger: true,
    });
    if (ok) save.mutate({ providers: providers.filter((_, i) => i !== index) });
  };

  const saveProvider = (index: number, provider: Provider) =>
    save.mutate({
      providers:
        index < providers.length
          ? providers.map((p, i) => (i === index ? provider : p))
          : [...providers, provider],
    });

  return (
    <ErrorScope error={save.error}>
      <div className="flex flex-col gap-6">
        {!editing && <UnclaimedErrors />}
        {collections.length > 1 && (
          <Select
            label="Collection"
            value={collection.name}
            onChange={(e) => setSelected(e.target.value)}
          >
            {collections.map((c) => (
              <option key={c.id} value={c.name}>
                {c.name}
              </option>
            ))}
          </Select>
        )}
        <Switch
          label="Enable OAuth2"
          checked={oauth2.enabled}
          onChange={(enabled) => save.mutate({ enabled })}
        />
        {enabled.length > 0 && (
          <>
            <ul
              aria-label="Enabled providers"
              className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3"
            >
              {enabled.map(({ provider, index }) => (
                <ProviderCard
                  key={provider.name}
                  name={provider.name}
                  label={labelOf(provider)}
                  status={oauth2.enabled ? "Enabled" : "Configured"}
                  onConfigure={() => setEditing({ index, provider })}
                  onDisable={() => void disable(index, labelOf(provider))}
                />
              ))}
            </ul>
            <hr className="border-line" />
          </>
        )}
        <ul
          aria-label="Other providers"
          className="grid grid-cols-[repeat(auto-fill,minmax(18rem,1fr))] gap-3"
        >
          {others.map((info: ProviderInfo) => (
            <ProviderCard
              key={info.name}
              name={info.name}
              label={info.displayName}
              onConfigure={() =>
                setEditing({
                  index: providers.length,
                  provider: { name: info.name },
                })
              }
            />
          ))}
        </ul>
        {editing && (
          <ProviderDialog
            provider={editing.provider}
            errorPath={`oauth2.providers.${editing.index}`}
            onCancel={() => {
              setEditing(null);
              save.reset();
            }}
            onSave={(p) => saveProvider(editing.index, p)}
            submitLabel={
              editing.index < providers.length ? "Save changes" : "Create"
            }
          />
        )}
      </div>
    </ErrorScope>
  );
}

function ProviderCard({
  name,
  label,
  status,
  onConfigure,
  onDisable,
}: {
  name: string;
  label: string;
  status?: "Enabled" | "Configured";
  onConfigure: () => void;
  onDisable?: () => void;
}) {
  return (
    <li className="flex items-center gap-3 rounded-base border border-line-strong bg-surface p-3">
      <ProviderLogo name={name} displayName={label} />
      <div className="min-w-0 flex-1">
        <span className="block break-words text-sm text-text">{label}</span>
        <span className="block break-all text-xs text-muted">{name}</span>
      </div>
      {status && (
        <Badge tone={status === "Enabled" ? "success" : "neutral"}>
          {status}
        </Badge>
      )}
      {onDisable && (
        <Button
          variant="ghost"
          size="sm"
          aria-label={`Disable ${label}`}
          title="Disable"
          icon={<PowerOff size={15} strokeWidth={1.75} aria-hidden="true" />}
          onClick={onDisable}
        />
      )}
      <Button
        variant="ghost"
        size="sm"
        aria-label={`Configure ${label}`}
        title="Configure"
        icon={<GearIcon size={15} strokeWidth={1.75} aria-hidden="true" />}
        onClick={onConfigure}
      />
    </li>
  );
}
