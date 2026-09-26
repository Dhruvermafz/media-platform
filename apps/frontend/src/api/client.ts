const BASE_URL = import.meta.env.VITE_API_BASE_URL ?? '/api';

export class ApiError extends Error {
  constructor(
    public status: number,
    public body: any,
  ) {
    super(body?.message ?? `Request failed with status ${status}`);
  }
}

function authHeaders(): Record<string, string> {
  const token = localStorage.getItem('accessToken');
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders(),
      ...options.headers,
    },
  });
  if (res.status === 204) return undefined as T;
  const body = await res.json().catch(() => undefined);
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export interface AuthResponse {
  user: { id: string; email: string };
  accessToken: string;
}

export interface Asset {
  id: string;
  fileName: string;
  mimeType: string;
  kind: 'IMAGE' | 'VIDEO';
  fileSize: number;
  status: 'UPLOADING' | 'UPLOADED' | 'PROCESSING' | 'READY' | 'FAILED';
  createdAt: string;
  variants?: Array<{ id: string; type: string; downloadUrl: string; width?: number; height?: number }>;
}

export interface Job {
  id: string;
  assetId: string;
  type: string;
  status: 'PENDING' | 'PROCESSING' | 'COMPLETED' | 'FAILED' | 'RETRY' | 'DEAD_LETTER';
  attempt: number;
  maxAttempts: number;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const api = {
  register: (email: string, password: string) =>
    request<AuthResponse>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password }) }),

  login: (email: string, password: string) =>
    request<AuthResponse>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),

  getUploadUrl: (fileName: string, mimeType: string, fileSize: number) =>
    request<{ uploadUrl: string; storageKey: string; method: 'PUT' }>('/assets/upload-url', {
      method: 'POST',
      body: JSON.stringify({ fileName, mimeType, fileSize }),
    }),

  confirmUpload: (storageKey: string, fileName: string, mimeType: string) =>
    request<Asset>('/assets', { method: 'POST', body: JSON.stringify({ storageKey, fileName, mimeType }) }),

  listAssets: (page = 1) => request<{ items: Asset[]; total: number }>(`/assets?page=${page}`),

  getAsset: (id: string) => request<Asset>(`/assets/${id}`),

  deleteAsset: (id: string) => request<void>(`/assets/${id}`, { method: 'DELETE' }),

  getJobsForAsset: (assetId: string) => request<Job[]>(`/assets/${assetId}/jobs`),

  retryJob: (jobId: string) => request<Job>(`/jobs/${jobId}/retry`, { method: 'POST' }),

  getAdminStats: () =>
    request<{
      totalAssets: number;
      assetsByStatus: Record<string, number>;
      jobsByStatus: Record<string, number>;
      queueDepths: Record<string, number>;
      deadLetterDepths: Record<string, number>;
      activeWorkers: Record<string, number>;
      averageProcessingTimeMs: number | null;
      p95ProcessingTimeMs: number | null;
      retryCount: number;
      deadLetterJobCount: number;
    }>('/admin/stats'),

  getFailedJobs: () =>
    request<Array<Job & { asset: { fileName: string } }>>('/admin/jobs/failed'),
};

export async function uploadFileDirect(uploadUrl: string, file: File): Promise<void> {
  const res = await fetch(uploadUrl, { method: 'PUT', body: file, headers: { 'Content-Type': file.type } });
  if (!res.ok) throw new Error(`Upload to storage failed with status ${res.status}`);
}
