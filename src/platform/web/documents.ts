import type { DocumentsPlatform } from '../types'

/** Browser counterpart of Android's Storage Access Framework document picker. */
export function createWebDocuments(): DocumentsPlatform {
  return {
    async save(fileName, mimeType, contents) {
      const url = URL.createObjectURL(new Blob([contents], { type: mimeType }))
      try {
        const link = document.createElement('a')
        link.href = url
        link.download = fileName
        link.click()
        return true
      } finally {
        URL.revokeObjectURL(url)
      }
    },

    open(mimeTypes) {
      return new Promise((resolve, reject) => {
        const input = document.createElement('input')
        input.type = 'file'
        input.accept = mimeTypes.join(',')

        // Browsers do not emit change when their picker is cancelled. Focus returns to
        // the page first, so settle on the next turn unless change already won the race.
        let settled = false
        const finish = (value: string | null, error?: unknown) => {
          if (settled) return
          settled = true
          window.removeEventListener('focus', onFocus)
          if (error) reject(error)
          else resolve(value)
        }
        const onFocus = () => setTimeout(() => finish(null), 0)

        input.addEventListener('change', () => {
          const file = input.files?.[0]
          if (!file) {
            finish(null)
            return
          }
          void file.text().then((text) => finish(text), (error) => finish(null, error))
        })
        window.addEventListener('focus', onFocus)
        input.click()
      })
    },
  }
}
