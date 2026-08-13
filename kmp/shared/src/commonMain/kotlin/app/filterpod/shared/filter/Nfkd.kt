package app.filterpod.shared.filter

/** NFKD normalization; no common-stdlib implementation exists, so per-platform. */
expect fun nfkd(input: String): String
