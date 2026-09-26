import type {
  ActivityPage, AdminStats, AdminUser, AssetDetail, AssetSummary, AuthResponse, BulkAction, Collection, FailedJob,
  JobList, JobStatus, ListFilters, Page, Profile, PublicShare, RequestableType, Role, ShareLink, Tag, Usage,
} from './types';

const BASE = '/api';
const TOKEN_KEY = 'accessToken';

export const tokenStore = {
  get: () => localStorage.getItem(TOKEN_KEY),
  set: (t: string) => localStorage.setItem(TOKEN_KEY, t),
  clear: () => localStorage.removeItem(TOKEN_KEY),
};

/** Thrown for every non-2xx. `code` is the API's machine-readable
 * discriminator (QUOTA_EXCEEDED, PASSWORD_REQUIRED, ...) when it sent one. */
export class ApiError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
    this.name = 'ApiError';
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) { onUnauthorized = fn; }

interface Opts { method?: string; body?: unknown; headers?: Record<string, string>; auth?: boolean; signal?: AbortSignal }

async function request<T>(path: string, opts: Opts = {}): Promise<T> {
  const { method = 'GET', body, headers = {}, auth = true, signal } = opts;
  const token = tokenStore.get();
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      signal,
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw err;
    throw new ApiError(0, 'Cannot reach the server. Check your connection and try again.', 'NETWORK');
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  const data = text ? safeJson(text) : undefined;
  if (!res.ok) {
    const raw = (data as { message?: string | string[] } | undefined)?.message;
    const message = Array.isArray(raw) ? raw.join(', ') : raw || res.statusText || 'Request failed';
    // A rejected token means the session is over - unless it is a login attempt itself.
    if (res.status === 401 && auth && token) onUnauthorized?.();
    throw new ApiError(res.status, message, (data as { code?: string } | undefined)?.code);
  }
  return data as T;
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

export function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export const api = {
  // auth
  register: (email: string, password: string, displayName?: string) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: { email, password, displayName: displayName || undefined }, auth: false }),
  login: (email: string, password: string) => request<AuthResponse>('/auth/login', { method: 'POST', body: { email, password }, auth: false }),

  // account
  me: () => request<Profile>('/me'),
  updateMe: (displayName: string) => request<Profile>('/me', { method: 'PATCH', body: { displayName } }),
  changePassword: (currentPassword: string, newPassword: string) => request<{ message: string }>('/me/password', { method: 'POST', body: { currentPassword, newPassword } }),
  usage: () => request<Usage>('/me/usage'),

  // assets
  listAssets: (f: ListFilters, page: number, pageSize = 60, signal?: AbortSignal) =>
    request<Page<AssetSummary>>(`/assets${qs({ ...f, favorite: f.favorite ? 'true' : undefined, trashed: f.trashed ? 'true' : undefined, page, pageSize })}`, { signal }),
  getAsset: (id: string) => request<AssetDetail>(`/assets/${id}`),
  updateAsset: (id: string, patch: { title?: string; description?: string; isFavorite?: boolean }) => request<AssetDetail>(`/assets/${id}`, { method: 'PATCH', body: patch }),
  setTags: (id: string, tags: string[]) => request<AssetDetail>(`/assets/${id}/tags`, { method: 'PUT', body: { tags } }),
  trash: (id: string) => request<void>(`/assets/${id}/trash`, { method: 'POST' }),
  restore: (id: string) => request<void>(`/assets/${id}/restore`, { method: 'POST' }),
  deleteForever: (id: string) => request<void>(`/assets/${id}`, { method: 'DELETE' }),
  bulk: (ids: string[], action: BulkAction, extra: { collectionId?: string; tags?: string[] } = {}) =>
    request<{ affected: number }>('/assets/bulk', { method: 'POST', body: { ids, action, ...extra } }),
  download: (id: string, variantId?: string) => request<{ url: string; fileName: string }>(`/assets/${id}/download${qs({ variantId })}`),
  requestVariant: (id: string, type: RequestableType, params?: Record<string, unknown>) =>
    request<{ job: { id: string; status: JobStatus }; created: boolean }>(`/assets/${id}/variants`, { method: 'POST', body: { type, params } }),
  assetJobs: (id: string) => request<import('./types').Job[]>(`/assets/${id}/jobs`),

  // uploads
  uploadUrl: (fileName: string, mimeType: string, fileSize: number) =>
    request<{ uploadUrl: string; storageKey: string }>('/assets/upload-url', { method: 'POST', body: { fileName, mimeType, fileSize } }),
  confirmUpload: (body: { storageKey: string; fileName: string; mimeType: string; collectionId?: string }) =>
    request<AssetSummary>('/assets', { method: 'POST', body }),

  // collections & tags
  collections: () => request<Collection[]>('/collections'),
  collection: (id: string) => request<Collection>(`/collections/${id}`),
  createCollection: (name: string, description?: string) => request<Collection>('/collections', { method: 'POST', body: { name, description } }),
  updateCollection: (id: string, patch: { name?: string; description?: string }) => request<Collection>(`/collections/${id}`, { method: 'PATCH', body: patch }),
  deleteCollection: (id: string) => request<void>(`/collections/${id}`, { method: 'DELETE' }),
  tags: () => request<Tag[]>('/tags'),
  renameTag: (id: string, name: string) => request<Tag>(`/tags/${id}`, { method: 'PATCH', body: { name } }),
  deleteTag: (id: string) => request<void>(`/tags/${id}`, { method: 'DELETE' }),

  // sharing
  shares: (target?: { assetId?: string; collectionId?: string }) => request<ShareLink[]>(`/shares${qs(target ?? {})}`),
  createShare: (body: { assetId?: string; collectionId?: string; expiresInHours?: number; password?: string; allowDownload?: boolean }) =>
    request<ShareLink>('/shares', { method: 'POST', body }),
  revokeShare: (id: string) => request<void>(`/shares/${id}`, { method: 'DELETE' }),
  publicShare: (token: string, password?: string) =>
    request<PublicShare>(`/public/shares/${encodeURIComponent(token)}`, { auth: false, headers: password ? { 'x-share-password': password } : {} }),

  // jobs / activity
  jobs: (status?: JobStatus) => request<JobList>(`/jobs${qs({ status, limit: 100 })}`),
  retryJob: (id: string) => request<unknown>(`/jobs/${id}/retry`, { method: 'POST' }),
  activity: (cursor?: string) => request<ActivityPage>(`/activity${qs({ limit: 40, cursor })}`),

  // admin
  adminStats: () => request<AdminStats>('/admin/stats'),
  adminFailedJobs: () => request<FailedJob[]>('/admin/jobs/failed?limit=50'),
  adminRetryJob: (id: string) => request<unknown>(`/admin/jobs/${id}/retry`, { method: 'POST' }),
  adminUsers: () => request<AdminUser[]>('/admin/users'),
  adminUpdateUser: (id: string, patch: { role?: Role; storageQuotaBytes?: number }) => request<AdminUser>(`/admin/users/${id}`, { method: 'PATCH', body: patch }),
};

export const eventsUrl = `${BASE}/events`;
