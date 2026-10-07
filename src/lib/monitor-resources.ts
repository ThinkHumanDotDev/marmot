/**
 * Client-safe constants for the monitor resources (tags, proxies, Docker hosts), shared by the
 * collections, the route handlers and the settings UI. No server-only imports here.
 */

/** `#rgb` or `#rrggbb`. */
export const TAG_COLOR_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i

/**
 * Uptime Kuma's tag palette (`src/components/TagEditDialog.vue`). `key` names the colour's label in
 * `settings.tags.colors`.
 */
export const TAG_COLORS = [
  { key: 'grey', value: '#4B5563' },
  { key: 'red', value: '#DC2626' },
  { key: 'orange', value: '#D97706' },
  { key: 'green', value: '#059669' },
  { key: 'blue', value: '#2563EB' },
  { key: 'indigo', value: '#4F46E5' },
  { key: 'purple', value: '#7C3AED' },
  { key: 'pink', value: '#DB2777' },
] as const

/** A tag as monitors and status pages display it. */
export interface MonitorTagChip {
  /** Tag id (absent on public status pages). */
  id?: string
  name: string
  color?: string | null
  value?: string | null
}

/** Proxy protocols Uptime Kuma supports (`server/proxy.js`). */
export const PROXY_PROTOCOLS = ['http', 'https', 'socks', 'socks5', 'socks5h', 'socks4'] as const
export type ProxyProtocol = (typeof PROXY_PROTOCOLS)[number]

export const DOCKER_CONNECTION_TYPES = ['socket', 'tcp'] as const
export type DockerConnectionType = (typeof DOCKER_CONNECTION_TYPES)[number]

export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock'

/** `tcp://`, `http://` or `https://` URL of a Docker Engine API. */
export const DOCKER_URL_PATTERN = /^(?:tcp|https?):\/\/[^\s/]+/i

/** Docker container names and ids: `[a-zA-Z0-9][a-zA-Z0-9_.-]*` (a leading `/` is tolerated). */
export const DOCKER_CONTAINER_PATTERN = /^\/?[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/
