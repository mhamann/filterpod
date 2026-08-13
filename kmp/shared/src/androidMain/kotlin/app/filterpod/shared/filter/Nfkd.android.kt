package app.filterpod.shared.filter

import java.text.Normalizer

actual fun nfkd(input: String): String = Normalizer.normalize(input, Normalizer.Form.NFKD)
