package app.filterpod.shared.db

import app.cash.sqldelight.db.SqlDriver

/** Platform-specific SQLite driver; the schema and queries are common. */
expect class DriverFactory {
    fun createDriver(): SqlDriver
}

fun createDatabase(factory: DriverFactory): FilterPodDb = FilterPodDb(factory.createDriver())
