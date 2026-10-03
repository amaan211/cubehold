export class UploadError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Upload one file into a server folder. XHR rather than fetch, for upload
 * progress. The custom header is required by the API (a cross-site form
 * cannot send it).
 */
export function uploadFile(opts: {
  serverId: string;
  dir: string;
  file: File;
  overwrite: boolean;
  onProgress?: (fraction: number) => void;
}): Promise<{ path: string; sizeBytes: number }> {
  const q = new URLSearchParams({
    dir: opts.dir,
    name: opts.file.name,
    overwrite: opts.overwrite ? "1" : "0",
  });
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/servers/${encodeURIComponent(opts.serverId)}/files/upload?${q}`);
    xhr.setRequestHeader("content-type", "application/octet-stream");
    xhr.setRequestHeader("x-cubehold-upload", "1");
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body: { error?: string; path?: string; sizeBytes?: number } = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = {};
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve({ path: body.path ?? "", sizeBytes: body.sizeBytes ?? 0 });
      } else {
        reject(new UploadError(xhr.status, body.error ?? `Upload failed (HTTP ${xhr.status})`));
      }
    };
    xhr.onerror = () => reject(new UploadError(0, "Upload failed: connection lost"));
    xhr.send(opts.file);
  });
}

export function downloadUrl(serverId: string, path: string): string {
  return `/api/servers/${encodeURIComponent(serverId)}/files/download?${new URLSearchParams({ path })}`;
}

export function zipUrl(serverId: string, dir: string, names: string[]): string {
  return `/api/servers/${encodeURIComponent(serverId)}/files/zip?${new URLSearchParams({
    dir,
    names: JSON.stringify(names),
  })}`;
}
