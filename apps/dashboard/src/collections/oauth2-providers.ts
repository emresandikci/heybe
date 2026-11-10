export interface ProviderInfo {
  name: string;
  displayName: string;
  needsURLs: boolean;
}

export const OAUTH2_PROVIDERS: ProviderInfo[] = [
  { name: "apple", displayName: "Apple", needsURLs: false },
  { name: "google", displayName: "Google", needsURLs: false },
  { name: "microsoft", displayName: "Microsoft", needsURLs: false },
  { name: "yandex", displayName: "Yandex", needsURLs: false },
  { name: "facebook", displayName: "Facebook", needsURLs: false },
  { name: "instagram2", displayName: "Instagram", needsURLs: false },
  { name: "github", displayName: "GitHub", needsURLs: false },
  { name: "gitlab", displayName: "GitLab", needsURLs: false },
  { name: "bitbucket", displayName: "Bitbucket", needsURLs: false },
  { name: "gitee", displayName: "Gitee", needsURLs: false },
  { name: "gitea", displayName: "Gitea/Forgejo", needsURLs: false },
  { name: "discord", displayName: "Discord", needsURLs: false },
  { name: "twitter", displayName: "X/Twitter", needsURLs: false },
  { name: "kakao", displayName: "Kakao", needsURLs: false },
  { name: "vk", displayName: "ВКонтакте", needsURLs: false },
  { name: "linear", displayName: "Linear", needsURLs: false },
  { name: "notion", displayName: "Notion", needsURLs: false },
  { name: "monday", displayName: "monday.com", needsURLs: false },
  { name: "lark", displayName: "Lark", needsURLs: false },
  { name: "box", displayName: "Box", needsURLs: false },
  { name: "spotify", displayName: "Spotify", needsURLs: false },
  { name: "trakt", displayName: "Trakt", needsURLs: false },
  { name: "twitch", displayName: "Twitch", needsURLs: false },
  { name: "patreon", displayName: "Patreon", needsURLs: false },
  { name: "strava", displayName: "Strava", needsURLs: false },
  { name: "wakatime", displayName: "WakaTime", needsURLs: false },
  { name: "livechat", displayName: "LiveChat", needsURLs: false },
  { name: "mailcow", displayName: "mailcow", needsURLs: true },
  { name: "planningcenter", displayName: "Planning Center", needsURLs: false },
  { name: "oidc", displayName: "OIDC", needsURLs: true },
  { name: "oidc2", displayName: "OIDC", needsURLs: true },
  { name: "oidc3", displayName: "OIDC", needsURLs: true },
];

const ALPHABET =
  "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

export function randomSecret(length = 50): string {
  const bytes = crypto.getRandomValues(new Uint32Array(length));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join("");
}
