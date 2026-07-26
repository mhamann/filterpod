import type { FilesPlatform, StoredFile } from '../types'

/**
 * Browser file storage on OPFS (Origin Private File System).
 *
 * OPFS is used rather than IndexedDB blobs because episode audio runs to tens of
 * megabytes and OPFS streams writes without holding the whole file in memory.
 * Keys are flattened (`/` → `__`) so the store stays a single flat directory.
 */

const encodeKey = (key: string) => key.replace(/\//g, '__')
const decodeKey = (name: string) => name.replace(/__/g, '/')

async function root(): Promise<FileSystemDirectoryHandle> {
  if (!navigator.storage?.getDirectory) {
    throw new Error('OPFS is unavailable in this browser')
  }
  return navigator.storage.getDirectory()
}

/** Object URLs are revoked when superseded so downloaded episodes do not leak. */
const objectUrls = new Map<string, string>()

export function createWebFiles(): FilesPlatform {
  return {
    async write(key, data): Promise<StoredFile> {
      const dir = await root()
      const handle = await dir.getFileHandle(encodeKey(key), { create: true })
      const writable = await handle.createWritable()
      await writable.write(data)
      await writable.close()
      const file = await handle.getFile()
      return { key, size: file.size }
    },

    async toPlayableUrl(key) {
      const dir = await root()
      const handle = await dir.getFileHandle(encodeKey(key))
      const file = await handle.getFile()
      const previous = objectUrls.get(key)
      if (previous) URL.revokeObjectURL(previous)
      const url = URL.createObjectURL(file)
      objectUrls.set(key, url)
      return url
    },

    async read(key) {
      const dir = await root()
      const handle = await dir.getFileHandle(encodeKey(key))
      const file = await handle.getFile()
      return file.arrayBuffer()
    },

    async delete(key) {
      const dir = await root()
      try {
        await dir.removeEntry(encodeKey(key))
      } catch {
        // Already gone is a success for our purposes.
      }
      const url = objectUrls.get(key)
      if (url) {
        URL.revokeObjectURL(url)
        objectUrls.delete(key)
      }
    },

    async exists(key) {
      const dir = await root()
      try {
        await dir.getFileHandle(encodeKey(key))
        return true
      } catch {
        return false
      }
    },

    async list(prefix = '') {
      const dir = await root()
      const out: StoredFile[] = []
      // Directory async iteration is not yet in the TS DOM lib.
      const entries = (dir as unknown as {
        entries(): AsyncIterableIterator<[string, FileSystemHandle]>
      }).entries()
      for await (const [name, handle] of entries) {
        if (handle.kind !== 'file') continue
        const key = decodeKey(name)
        if (prefix && !key.startsWith(prefix)) continue
        const file = await (handle as FileSystemFileHandle).getFile()
        out.push({ key, size: file.size })
      }
      return out
    },

    async usageBytes() {
      // Sums our own files rather than using storage.estimate(), which counts the
      // whole origin — IndexedDB and the cached ASR model weights included. The
      // storage meter is about downloaded episodes, so it must not report those.
      const files = await this.list()
      return files.reduce((sum, file) => sum + file.size, 0)
    },

    async requestPersistence() {
      return (await navigator.storage?.persist?.()) ?? false
    },
  }
}
